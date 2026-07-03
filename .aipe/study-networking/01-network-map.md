# The network map

*Wire path (Language-agnostic)* — the full on-the-wire path and every
network boundary this repo crosses.

## Zoom out — where this concept lives

The network map isn't a mechanism you invoke; it's the *skeleton every
other concept in this guide hangs on*. Before you learn how timeouts
compose or how OAuth survives a cross-site return, you need to know
which hops exist, who owns each side, and what they carry.

```
  Zoom out — the three hops of blooming_insights

  ┌─ Browser (React 19) ─────────────────────────────────────────┐
  │  ★ NETWORK MAP LIVES HERE — every boundary this repo crosses  │
  │  fetch('/api/briefing?mode=live-bloomreach')                  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  hop 1: HTTPS · same origin
                                  │  Cookie: bi_session; bi_auth
                                  ▼
  ┌─ Next routes (Node runtime on Vercel) ───────────────────────┐
  │  app/api/briefing/route.ts · maxDuration = 300                │
  │  ReadableStream → NDJSON                                      │
  └────────────┬─────────────────────────────────────┬───────────┘
    hop 2: HTTPS · cross-origin                       hop 3: HTTPS
    Authorization: Bearer <OAuth>                     Authorization: Bearer
    to loomi-mcp-alpha.bloomreach.com/mcp             to api.anthropic.com
    ▼                                                 ▼
  ┌─ Bloomreach loomi-mcp ─────┐        ┌─ Anthropic messages API ────┐
  │  StreamableHTTP transport   │        │  claude-sonnet-4-6           │
  │  MCP protocol (JSON-RPC)    │        │  ephemeral prompt cache      │
  └─────────────────────────────┘        └──────────────────────────────┘
```

Three hops. Two upstream origins. Every other concept in this guide
narrows into one of them. This file names the hops so the rest can
skip the setup.

## The structure pass

Before we walk hops, pick one axis and trace it. The load-bearing axis
here is **who owns the timeout budget at each hop**, because it's what
composes the whole request into a bounded operation.

Layers:

  - **outer** — the browser fetch (no timeout by default; user closes tab)
  - **middle** — the Next route (`maxDuration = 300` from Vercel)
  - **inner** — the MCP transport (`AbortSignal.timeout(30_000)` per call)
  - **innermost** — the tool's own retry ladder (up to 60s of wall clock
    across the retries for one rate-limited call)

One question, four altitudes:

```
  Axis: "who bounds this call's wall-clock, and to what?"

  ┌───────────────────────────────────────────┐
  │ browser fetch (client)                    │   → no timeout set;
  └───────────────────────────────────────────┘     tab-close aborts
      ┌───────────────────────────────────────┐
      │ Next route (Vercel Pro)               │   → 300s hard ceiling
      │ maxDuration = 300                     │     (Node process killed)
      └───────────────────────────────────────┘
          ┌────────────────────────────────────┐
          │ MCP transport (per call)          │   → 30s AbortSignal.timeout
          │ TOOL_TIMEOUT_MS = 30_000          │
          └────────────────────────────────────┘
              ┌────────────────────────────────┐
              │ retry ladder (per rate-limit)  │  → up to 3 × 20s
              │ retryCeilingMs = 20_000        │    (60s wall clock max)
              └────────────────────────────────┘

  Seams flip at every layer — each has its own ownership.
```

**Seams** — the boundaries where the axis flips:

  - **browser → route** — the client doesn't bound the request; the route does.
    Client cancels via `req.signal.aborted` only when the tab closes or
    the effect unmounts (see `useBriefingStream.ts:298`).
  - **route → transport** — the route's `req.signal` is *composed* with the
    transport's per-call 30s timeout via `composeSignals` at
    `transport.ts:173`. Whichever fires first wins.
  - **transport → retry ladder** — timeouts fail fast (no retry); only
    rate-limited *results* (parsed from the response body) retry
    (`bloomreach-data-source.ts:164`). The retry ladder happens
    *inside* the 30s per-call budget only if the call itself returns
    quickly.

The whole cascade is engineered so a stuck upstream cannot burn the
300s Vercel budget — it fails at 30s, and only rate-limit *results*
(fast responses containing an error envelope) get patient retries.

## How it works

### Move 1 — the three hops as one shape

You've built `fetch()` calls before. This is three of them stacked: the
browser fetches the route, the route fetches Bloomreach *and* Anthropic
in a loop, and each hop has its own auth story. The pattern:

```
  The pattern — three hops, one composed signal

    hop 1                  hop 2              hop 3
  ┌───────┐   NDJSON     ┌────────┐   MCP   ┌────────────┐
  │Browser│ ─────────► │ Route  │ ──────► │ Bloomreach │
  │       │ ◄───────── │        │ ◄────── │            │
  └───────┘  stream    └───┬────┘         └────────────┘
                           │  in a ReAct loop:
                           │  after each tool result…
                           ▼
                        ┌──────────┐
                        │Anthropic │
                        └──────────┘

  one AbortSignal composed through all three
  (req.signal ∨ AbortSignal.timeout(30_000))
```

The route is the fan-out point. For a single briefing the route makes
one hop-1 outbound stream to the browser, ~5-15 hop-2 calls to
Bloomreach, and ~5-10 hop-3 calls to Anthropic. All bounded by one
composed signal.

### Move 2 — walk each hop

#### Hop 1 — browser to Next route

Same-origin over HTTPS (Vercel handles TLS termination at the edge; the
route sees plain HTTP inside the Vercel network). Body flows as NDJSON
in the response; the request body is always small (query params only).

Code that produces it (route side) — `app/api/briefing/route.ts:330-335`:

```ts
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
    },
  });
```

Two headers matter here. `application/x-ndjson` is what the client
sniffs to decide the streaming branch vs the demo-snapshot JSON branch
(`useBriefingStream.ts:185-199`). `no-store, no-transform` prevents any
intermediate cache from buffering the stream — critical, because a
proxy that buffers a chunked NDJSON response defeats the whole reveal
timing.

Code that consumes it (client side) — `lib/streaming/ndjson.ts:32-51`:

```ts
  while (true) {
    if (opts?.cancelOn?.()) {           // effect-unmount cancellation
      await reader.cancel();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';            // partial final line stays buffered
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try { onEvent(JSON.parse(line) as E); }
      catch (err) { opts?.onMalformed?.(line, err); }
    }
  }
```

**Cookies attached to hop 1**: `bi_session` (session id, always) and
`bi_auth` (encrypted OAuth state, production only). Both `httpOnly` +
`SameSite=None` + `Secure` in production (`lib/mcp/session.ts:12`,
`lib/mcp/auth.ts:98`) so the cross-site OAuth return survives — see
`04-tls-and-trust-establishment.md`.

**Failure mode**: proxy buffering. A misconfigured intermediate that
buffers the full response before flushing turns the progressive reveal
into a single dump at the end. `no-store, no-transform` is the guard,
and Vercel's edge respects it.

#### Hop 2 — Next route to Bloomreach loomi-mcp

Cross-origin HTTPS to `https://loomi-mcp-alpha.bloomreach.com/mcp`
(overridable via `BLOOMREACH_MCP_URL` at `lib/mcp/connect.ts:32`).
Carries MCP protocol messages (JSON-RPC over StreamableHTTP transport
from `@modelcontextprotocol/sdk` v1.29).

The transport is constructed once per session (`connect.ts:76`):

```ts
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: provider,
    fetch: makeCapturingFetch(httpErrors),
  });
```

Two hooks matter here:

  - `authProvider` — attaches `Authorization: Bearer <access_token>` to
    every call, refreshes when the SDK detects a 401, and captures the
    authorize URL to redirect the browser to for the OAuth dance.
  - `fetch: makeCapturingFetch(httpErrors)` — a wrapper that records
    the body of any non-OK response into a holder
    (`lib/mcp/transport.ts:103-118`), so the transport can attach the
    *real* server error body (e.g. `{"error":"rate limit reached (1 per
    10 second)"}`) to the thrown error rather than a generic
    `Unauthorized`. Tokens are stripped before the body lands in the
    holder.

Each `callTool` composes the request with a per-call 30s timeout
(`transport.ts:131`):

```ts
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  return await this.client.callTool({ name, arguments: args }, undefined, { signal });
```

**Failure modes**:
  - **timeout** → `HTTP 0: timeout after 30000ms` at `transport.ts:137`.
    Fails fast — no retry.
  - **rate limit** → returns a tool result with `isError: true` and
    "rate limit reached" text; the outer `BloomreachDataSource.callTool`
    retries up to 3 times, honoring the parsed window
    (`bloomreach-data-source.ts:164-174`).
  - **401 invalid_token** → the alpha server revokes tokens after
    minutes; the transport surfaces the body, the browser's reconnect
    policy (`useReconnectPolicy.ts:33`) matches `invalid_token` or
    `unauthor…` in the error message, and the client fires
    `POST /api/mcp/reset` + reload.

#### Hop 3 — Next route to Anthropic

Cross-origin HTTPS via `@anthropic-ai/sdk` v0.99 to the default
`api.anthropic.com` origin. The SDK owns connection handling entirely —
this repo doesn't override base URL, retry, or transport.

The only wire-level touchpoint the app controls is the
`cache_control` breakpoint added to the system prompt
(`lib/agents/aptkit-adapters.ts:85-89`):

```ts
  if (request.system) {
    params.system = [
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ];
  }
```

Everything after the breakpoint (the message history, the tool results)
gets cached under Anthropic's 5-minute ephemeral prefix scheme. First
call in a ReAct loop reports `cache_creation_input_tokens`; every
subsequent call within 5 minutes reports `cache_read_input_tokens` at
~10% of the input cost. Baseline shows `3168` tokens created then read
on the next turn — 90% saving on the prefix.

**Failure modes**:
  - **HTTP 429** — SDK retries with backoff by default (not overridden).
  - **HTTP 5xx** — same, SDK retries.
  - **Request signal aborted** — the SDK accepts a `signal` option
    (`aptkit-adapters.ts:93-94`), so a route-level cancel propagates
    into an in-flight LLM call.

### Move 3 — the principle

Every network hop has an *owner of its timeout budget*. When you see
three hops stacked, ask which one bounds the whole thing. Here it's the
outermost (`maxDuration = 300` on Vercel Pro), sliced by the innermost
(`AbortSignal.timeout(30_000)` per MCP call), which makes the app
resilient to a stuck upstream without wasting the entire budget on one
call. This is the pattern to reach for when composing any long-running
request across multiple services.

## Primary diagram

The full recap — every hop, every wrapper, every timeout:

```
  Primary — the three hops with all owners named

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  fetch('/api/briefing?mode=live-bloomreach')                  │
  │  readNdjson(res.body, handle, { cancelOn: cancelledRef })     │
  │    ← cancels on effect-unmount (client-side cancel signal)    │
  └──────────────────────────┬────────────────────────────────────┘
                             │ hop 1 · HTTPS · Cookie: bi_*
                             ▼
  ┌─ Next route (route.ts) ──────────────────────────────────────┐
  │  maxDuration = 300                                             │
  │  req.signal (fires on client disconnect)                       │
  │  ReadableStream → controller.enqueue(encodeEvent(e))           │
  └───┬───────────────────────────────────────────────┬───────────┘
      │ per-call composed signal:                     │ per-call signal:
      │ (req.signal ∨ AbortSignal.timeout(30_000))    │ request.signal
      │                                                │
      ▼ hop 2 · HTTPS                                  ▼ hop 3 · HTTPS
  ┌─ SdkTransport (transport.ts) ──────────┐   ┌─ AnthropicAdapter ─┐
  │  callTool(name, args, {signal}):        │   │  anthropic.messages│
  │    isTimeoutError → HTTP 0 (fail fast)  │   │    .create(params, │
  │    else → HTTP <status>: <redacted body>│   │      { signal })   │
  └──────────────────┬──────────────────────┘   └─────────┬──────────┘
                     ▼                                     ▼
  ┌─ Bloomreach ─┐                                ┌─ Anthropic ─┐
  │ MCP JSON-RPC │                                │ /v1/messages│
  │ Bearer <tok> │                                │ Bearer <key>│
  └──────────────┘                                └─────────────┘

  ↑ BloomreachDataSource sits *between* the route and SdkTransport,
    adding 1.1s proactive spacing + rate-limit retry ladder that only
    fires on isError results — timeouts still fail fast at the transport.
```

## Elaborate

The three-hop shape isn't accidental — it's a specific product decision:

  - **Bloomreach hop is auth-guarded** because the workspace data is
    per-user and gated behind OAuth. This is why the route returns
    401 + `needsAuth` JSON *before* committing to the NDJSON stream
    (`briefing/route.ts:180-182`, `agent/route.ts:175`) — a 401 can't
    be signaled cleanly mid-stream.

  - **Anthropic hop is unauthed at the user level** because the
    Anthropic key is server-side; the user sees only the aggregated
    response, never the raw tool calls (though the reasoning trace is
    the intentional exception, revealed as first-class UI).

  - **Client-to-route hop is same-origin** because keeping it same-origin
    means `bi_auth` (which carries the Bloomreach OAuth tokens) never
    needs to be sent to a third party, and the app can rely on
    `SameSite=None` for the cross-site OAuth return without ever
    exposing the cookie to the LLM origin.

Related material: the OAuth callback flow specifically (why the redirect
URI is derived from `x-forwarded-host`) lives in
`02-dns-routing-and-addressing.md`. The retry ladder details are in
`07-timeouts-retries-pooling-and-backpressure.md`.

## Interview defense

**Q: Walk me through what happens on the wire when a user clicks "run
a live briefing" in this app.**

  Verdict first: three HTTPS hops, one composed timeout budget, an
  NDJSON stream flowing back the whole time.

```
  answer sketch — three hops, one budget

  browser fetch  ──►  Next route (bi_session)  ──►  Bloomreach (Bearer)
                          │                              ▲
                          │ ReAct loop                   │ 30s per call
                          ▼                              │ + retry ladder
                     Anthropic (Bearer)                  │
                          │                              │
                          ▼                              │
                     tool_call →  ─────────────────────► │
                     tool_result ←──────────────────────┘
                          │
                          ▼
                     NDJSON events streamed back to browser
```

  Anchor: `app/api/briefing/route.ts:19` (`maxDuration = 300`) plus
  `lib/mcp/transport.ts:38` (`TOOL_TIMEOUT_MS = 30_000`).

**Q: Why NDJSON over fetch instead of Server-Sent Events?**

  Direct: NDJSON-over-fetch lets us cancel the whole request via a
  single `AbortSignal` (composed from the route's `req.signal` and any
  per-call timeout). `EventSource` has no first-class cancel — you get
  `.close()` on the client but the fetch equivalent uses the same
  `AbortSignal` machinery as every other HTTP call in the app. It also
  works over the same `Cookie:` header path, and it lets the route
  branch to plain JSON (the demo snapshot) or NDJSON (live) without the
  client caring about the surface change.

  Anchor: `lib/streaming/ndjson.ts:32-51`, `useBriefingStream.ts:188-199`.

## See also

  - `02-dns-routing-and-addressing.md` — origin resolution + redirect_uri
  - `05-http-semantics-caching-and-cors.md` — headers, methods, cookies
  - `06-websockets-sse-streaming-and-realtime.md` — the NDJSON decision
  - `07-timeouts-retries-pooling-and-backpressure.md` — the composed budget
