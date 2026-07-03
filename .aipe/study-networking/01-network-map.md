# 01 — network map

## Subtitle

The on-the-wire topology (Language-agnostic — the physical picture; the mechanisms attach to specific boxes on it).

## Zoom out, then zoom in

Before any single hop, put the whole request on the map. Every user turn — clicking "briefing," opening an investigation, sending a chat query — kicks off the same three-hop shape: browser fetches a Next.js route, the route fans out to two upstreams (MCP server + Anthropic), the route streams NDJSON back to the browser while the fan-outs are still in flight. Three surfaces. All HTTPS. No WebSockets, no gRPC, no message broker.

```
  Zoom out — the three wire surfaces

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  Next.js React components                                  │
  │  useBriefingStream / useInvestigation → fetch()            │
  └───────────────────────────────┬────────────────────────────┘
                                  │  hop 1: HTTPS · NDJSON
                                  │  same-origin
                                  ▼
  ┌─ Service layer ────────────────────────────────────────────┐
  │  ★ THIS FILE ★                                             │  ← we are here
  │  Next.js route handlers (Vercel Node runtime)              │
  │  app/api/{briefing,agent}/route.ts                         │
  └──────────────┬─────────────────────────────┬───────────────┘
                 │ hop 2                       │ hop 3
                 │ HTTPS · MCP JSON-RPC        │ HTTPS · Anthropic
                 ▼                             ▼
  ┌─ Provider layer ──────────────┐  ┌─ Provider layer ────────┐
  │  MCP server (Bloomreach       │  │  Anthropic API          │
  │  by default; swappable)       │  │  api.anthropic.com      │
  └───────────────────────────────┘  └─────────────────────────┘
```

That middle band is where every network concern in this repo lives: auth, timeout, retry, cancellation, response cache. Zoom in — this file is the map itself. It names every box, every hop, what travels each direction, and which layer terminates which contract. The subsequent files walk one axis of the map at a time (DNS, TCP, TLS, HTTP semantics, streaming, timeouts).

## Structure pass

Before the mechanics, read the skeleton.

**Layers (outer → inner):**
- Client (browser JS)
- Edge (Vercel's TLS termination + routing)
- Route (Next.js Node function on Vercel)
- Upstream (Bloomreach MCP + Anthropic API)

**One axis, held constant across the layers — TRUST:**

```
  "who can read the credentials?" — traced down the stack

  ┌─────────────────────────────────────────────────────────────┐
  │  Client        → only its own cookies                       │
  │                  (bi_session UUID, bi_auth ciphertext)       │
  └────────────────────────┬────────────────────────────────────┘
      seam #1: TLS terminates at Vercel edge; app sees plaintext
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Route         → decrypts bi_auth with AUTH_SECRET;         │
  │                  handles OAuth tokens + PKCE + DCR in clear │
  │                  → sees Anthropic API key from env          │
  └────────────────────────┬────────────────────────────────────┘
      seam #2: outbound TLS to two different origins
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Upstreams     → MCP sees bearer/OAuth token                │
  │                  Anthropic sees API key + prompt payload    │
  └─────────────────────────────────────────────────────────────┘

  trust flips at each seam — that's the map's load-bearing shape
```

**Seams (where trust flips):**
- Seam #1 — the Vercel edge. TLS terminates here; the app sees plaintext HTTP + `x-forwarded-*` headers. Cookies decrypt server-side.
- Seam #2 — the two outbound HTTPS calls. Fresh TLS handshakes to two different origins; different auth material rides each.

**Layered decomposition, one question:** "what auth material rides this hop?" Client → route carries a session cookie + an encrypted-token cookie. Route → MCP carries `Authorization: Bearer <token>` (issued by OAuth 2.1 + PKCE + DCR against Bloomreach, or a static bearer, or nothing). Route → Anthropic carries `x-api-key: <ANTHROPIC_API_KEY>`. Three hops, three auth stories.

Skeleton mapped — hand off to How it works.

## How it works

### Move 1 — the mental model

Think of it like a `fetch()` inside a `fetch()` inside a `fetch()`. The browser opens one long-lived HTTPS request; while that request's response body is still streaming, the route on the other end is opening its own outbound requests to MCP and Anthropic. The route is a proxy in the classic sense — it hides two upstreams from the browser and multiplexes their progress into a single NDJSON stream back.

The picture to hold: **one request in, two requests out, one stream back.**

```
  The topology — request fan-out, stream fan-in

               ┌────────────────────┐
               │  browser fetch     │
               └────────┬───────────┘
                        │  1 in
                        ▼
               ┌────────────────────┐
               │  Next.js route     │  ← the multiplexer
               └────┬──────────┬────┘
                    │          │
                    │ 2 out    │
                    ▼          ▼
             ┌──────────┐  ┌──────────┐
             │  MCP     │  │Anthropic │
             │  server  │  │  API     │
             └────┬─────┘  └────┬─────┘
                  │             │
                  │  results merged back into
                  ▼             ▼
               ┌────────────────────┐
               │  NDJSON events →   │  ← one stream out
               │  browser handle()  │
               └────────────────────┘

  the shape people forget: the two outbound calls are
  interleaved into one inbound stream, not two separate ones
```

The load-bearing part of this shape: **the route's outbound calls happen while the inbound response body is still open.** The browser doesn't wait for MCP to finish before seeing progress; it sees each `reasoning_step` / `tool_call_start` / `tool_call_end` event the moment the route writes it. This is what makes an investigation feel live even when a diagnostic call takes 50 seconds.

### Move 2 — the walkthrough

Walk it one hop at a time. Each hop below names what travels, in which direction, under what auth, over what protocol.

#### Hop 1 — Browser → Route (same-origin HTTPS, NDJSON down)

The browser opens `GET /api/briefing?mode=live-mcp` (or `/api/agent?insightId=…`) with a `fetch()` call. Same-origin, so no CORS preflight. Two cookies ride the request automatically — `bi_session` (the UUID) and `bi_auth` (the AES-256-GCM ciphertext of the OAuth state). If the user has persisted an MCP config in localStorage, the hook attaches an `x-bi-mcp-config` header carrying base64-JSON.

```
  Hop 1 — Browser → Route (same-origin HTTPS)

  ┌─ Client band ──────────────────────────────────────────────┐
  │  fetch('/api/briefing?mode=live-mcp', {                    │
  │    headers: {                                              │
  │      // only set when localStorage has a persisted config  │
  │      'x-bi-mcp-config': persistedConfigHeader() // base64   │
  │    }                                                       │
  │    // cookies auto-attached: bi_session + bi_auth          │
  │  })                                                        │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 1 down: GET /api/briefing
                            │  cookies + optional header
                            ▼
  ┌─ Service band ─────────────────────────────────────────────┐
  │  route.ts opens ReadableStream<Uint8Array>                 │
  │  writes one JSON object per '\n' as agents make progress   │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 1 up (long-lived response):
                            │  Content-Type: application/x-ndjson
                            │  Cache-Control: no-cache, no-transform
                            │  { type: 'workspace', ... }\n
                            │  { type: 'coverage_item', ... }\n
                            │  { type: 'insight', ... }\n
                            │  { type: 'done' }\n
                            ▼
                            (browser reads chunk-by-chunk)
```

The client-side header attach lives in `lib/hooks/useBriefingStream.ts:164-169`:

```ts
// UI settings modal (Session D) persists MCP config in localStorage;
// send it as a header so the route can override env-driven defaults.
// Unset → header omitted → env-driven behavior preserved.
const mcpHeader = persistedConfigHeader();
const res = await fetch(url, {
  headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : undefined,
});
```

`persistedConfigHeader()` reads localStorage, JSON-serializes, base64-encodes, returns the string — or returns `null` when nothing's persisted so the caller omits the header entirely (`lib/mcp/config.ts:142-146`). Header-not-set is the default path; it means "use env config."

The response side is `app/api/agent/route.ts:106-109`:

```ts
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

`no-cache` keeps any intermediary from returning a cached stream. `no-transform` keeps gzip proxies from re-encoding the bytes mid-stream (which would break the `\n` boundary).

#### Hop 2 — Route → MCP server (HTTPS · MCP Streamable HTTP)

The route reads the `x-bi-mcp-config` header, decodes it fail-safely (any error → `null`, fall through to env), and calls `makeDataSource` with the override. Inside, `connectMcp` builds the MCP URL from the precedence chain, builds an auth provider (OAuth / bearer / anonymous), and hands both to the MCP SDK's `StreamableHTTPClientTransport`. Each `dataSource.callTool()` inside the ReAct loop opens one HTTPS request to the MCP URL, carrying `Authorization: Bearer <token>` and a JSON-RPC body naming the tool + args.

```
  Hop 2 — Route → MCP server

  ┌─ Service band ─────────────────────────────────────────────┐
  │  const override = decodeConfigHeader(                      │
  │    req.headers.get(BI_MCP_CONFIG_HEADER)                   │
  │  );                                                        │
  │  // → { url?, authType?, bearerToken? } or null            │
  │                                                            │
  │  const ds = await makeDataSource(mode, sid, override);     │
  │  // inside: connectMcp() → StreamableHTTPClientTransport   │
  │  //  URL:  override.url ?? MCP_URL ?? BLOOMREACH_MCP_URL   │
  │  //         ?? loomi-mcp-alpha.bloomreach.com/mcp/         │
  │  //  auth: override.authType ?? MCP_AUTH_TYPE ?? oauth-br  │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 2 down (per tool call):
                            │  POST /mcp/ HTTP/1.1
                            │  Host: <mcp-origin>
                            │  Authorization: Bearer <token>
                            │  Content-Type: application/json
                            │  body: { jsonrpc, id, method: "tools/call",
                            │          params: { name, arguments } }
                            │  + AbortSignal.timeout(30_000)
                            ▼
  ┌─ MCP server ───────────────────────────────────────────────┐
  │  responds with tool result envelope                        │
  │  (or 401 / 429 / 5xx — see 07-timeouts-retries-...)        │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 2 up: result / structuredContent
                            ▼
                        route handler
```

The URL resolution is `lib/mcp/connect.ts:38-48`:

```ts
function mcpUrl(override?: McpConfigOverride): URL {
  // Precedence: override.url (from UI settings modal, per-request header) →
  // MCP_URL env → BLOOMREACH_MCP_URL env (legacy) → Bloomreach alpha default.
  const raw =
    override?.url ??
    process.env.MCP_URL ??
    process.env.BLOOMREACH_MCP_URL ??
    'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, '')); // strip trailing slash(es) — avoids a 307
}
```

Bloomreach is a preset — the sensible default so a fresh clone works out of the box. Any HTTPS MCP endpoint plugs in via the header or env, no code change.

The auth provider is picked in `lib/mcp/auth-providers/index.ts:56-76`. Three implementations — `BloomreachAuthProvider` (OAuth 2.1 + PKCE + DCR), `BearerAuthProvider` (static token), `AnonymousAuthProvider` (no header) — all satisfy the MCP SDK's `OAuthClientProvider` interface. The route doesn't care which one; the transport just calls `.tokens()` and puts the result in `Authorization: Bearer <access_token>`.

#### Hop 3 — Route → Anthropic API (HTTPS · Messages API)

Same route, second outbound. The Anthropic SDK opens `POST https://api.anthropic.com/v1/messages` carrying `x-api-key: <ANTHROPIC_API_KEY>` and a JSON body with the conversation. This hop is where the ReAct loop's "reasoning + tool-choice" turn happens; the route interleaves this call with the MCP calls above.

```
  Hop 3 — Route → Anthropic API

  ┌─ Service band ─────────────────────────────────────────────┐
  │  const anthropic = new Anthropic({                         │
  │    apiKey: process.env.ANTHROPIC_API_KEY                   │
  │  });                                                       │
  │  await anthropic.messages.create({                         │
  │    model, max_tokens, messages, tools,                     │
  │    system: [                                               │
  │      { type: 'text', text: request.system,                 │
  │        cache_control: { type: 'ephemeral' } }              │
  │    ]                                                       │
  │  }, { signal });                                           │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 3 down:
                            │  POST /v1/messages HTTP/1.1
                            │  Host: api.anthropic.com
                            │  x-api-key: <key>
                            │  anthropic-version: 2023-06-01
                            │  Content-Type: application/json
                            │  body: { model, messages, tools,
                            │          system: [...cache_control...] }
                            ▼
  ┌─ Anthropic API ────────────────────────────────────────────┐
  │  first call: cache_creation_input_tokens 3168              │
  │  next calls in same conversation: cache_read_input_tokens  │
  │                                    3168 (verified live)    │
  └─────────────────────────┬──────────────────────────────────┘
                            │  hop 3 up: usage + content
                            ▼
                        route handler
```

The `cache_control: { type: 'ephemeral' }` marker is the load-bearing part of this hop. From `lib/agents/aptkit-adapters.ts:85-89`:

```ts
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

Wrapping the system prompt in an ephemeral cache breakpoint makes the first call a cache_creation (~1.25× normal input cost) and every subsequent call within ~5 min a cache_read (~0.1× normal). Tools also cache transparently once the system-prompt breakpoint is set. This is a network-layer feature exposed via the request payload; the header itself doesn't change, but the semantics of the field flip on caching upstream.

#### The multiplexer — interleaving the two upstreams into one stream

The route holds a `ReadableStream` open. Each event the agents produce — a reasoning step, a tool call start, a tool call end — gets written as one JSON object plus `\n`. From `app/api/agent/route.ts:189-215`:

```ts
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
    // ...
    const hooksFor = (agent: AgentName) => ({
      onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },
      onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
      onToolResult: (tc: ToolCall) => send({
        type: 'tool_call_end', toolName: tc.toolName, agent,
        durationMs: tc.durationMs ?? 0, result: trunc(tc.result), error: tc.error,
      }),
    });
```

Every `dataSource.callTool()` (hop 2) and every `anthropic.messages.create()` (hop 3) fires an `onToolCall` / `onText` hook. Each hook enqueues bytes onto the browser-facing stream (hop 1 up). The three hops are conceptually parallel; the multiplexer serializes their events into one wire.

### Move 3 — the principle

**The route handler is a proxy that terminates one request per user turn and originates two per turn.** That asymmetry — one in, two out — is why every network concern in this repo (auth, timeout, retry, cancellation) sits at the middle band. The browser side stays simple because the route hides both upstreams behind one contract (NDJSON events). The upstreams stay simple because they each see one bearer/API-key request at a time. The complexity is deliberately concentrated at the seam that owns it.

## Primary diagram

The full recap — every box, every arrow, every layer named.

```
  Full network map — three surfaces, all HTTPS

  ┌─ Client band (browser) ────────────────────────────────────┐
  │                                                            │
  │   React components (useBriefingStream, useInvestigation)   │
  │            │                                               │
  │            │ persistedConfigHeader() → base64(JSON)        │
  │            ▼                                               │
  │   fetch('/api/briefing?mode=live-mcp', {                   │
  │     headers: { 'x-bi-mcp-config': <base64> }               │
  │     // cookies auto: bi_session, bi_auth                   │
  │   })                                                       │
  │            │                                               │
  │   readNdjson(res.body, handle, { cancelOn })               │
  │                                                            │
  └────────────────────────┬───────────────────────────────────┘
                           │ hop 1 down (request):
                           │   GET · same-origin HTTPS
                           │   cookies: bi_session + bi_auth
                           │   header: x-bi-mcp-config (opt)
                           │
                           │ hop 1 up (response body):
                           │   Content-Type: application/x-ndjson
                           │   Cache-Control: no-cache, no-transform
                           │   one JSON per '\n', chunked stream
                           ▼
  ┌─ Edge band (Vercel) ───────────────────────────────────────┐
  │   TLS terminates here                                      │
  │   inserts x-forwarded-host, x-forwarded-proto              │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ Service band (Next.js route, Node runtime) ───────────────┐
  │                                                            │
  │   app/api/{briefing,agent}/route.ts                        │
  │     ├─ decodeConfigHeader(x-bi-mcp-config) → override|null │
  │     ├─ withAuthCookies() reads/writes bi_auth              │
  │     ├─ makeDataSource(mode, sid, override)                 │
  │     ├─ ReadableStream open · writes NDJSON as events fire  │
  │     └─ AbortSignal composed: req.signal + 30s timeout      │
  │                                                            │
  └──────────┬──────────────────────────────┬──────────────────┘
             │ hop 2 (per tool call)        │ hop 3 (per model turn)
             │                              │
             │ POST https://<mcp-origin>/mcp/│ POST https://api.anthropic.com/v1/messages
             │ Authorization: Bearer <tok>  │ x-api-key: <ANTHROPIC_API_KEY>
             │ Content-Type: application/json│ anthropic-version: 2023-06-01
             │ body: JSON-RPC tools/call    │ body: messages + tools +
             │ AbortSignal.timeout(30_000)  │       system[{cache_control: ephemeral}]
             │                              │
             ▼                              ▼
  ┌─ Upstream: MCP ──────────────┐  ┌─ Upstream: Anthropic ──┐
  │  loomi-mcp-alpha.bloomreach   │  │  api.anthropic.com     │
  │  .com/mcp/ (preset default)   │  │                        │
  │  — or override.url            │  │  prompt caching:       │
  │  — or MCP_URL env             │  │   creation → 3168 tok  │
  │  — or BLOOMREACH_MCP_URL env  │  │   read → 3168 tok      │
  │                               │  │                        │
  │  returns tool result envelope │  │  returns content +     │
  │  or 401 / 429 / 5xx           │  │  usage stats           │
  └───────────────────────────────┘  └────────────────────────┘
```

## Elaborate

**Where this shape comes from.** The classic 3-tier web architecture (browser → API → DB), evolved for the LLM era where the DB is replaced by two provider APIs and the "long-lived DB query" is replaced by a multi-turn agent loop. NDJSON-over-fetch is the modern replacement for both SSE and WebSockets in scenarios where you only need server→client push during an in-flight request; it works with any HTTP infrastructure that doesn't buffer response bodies (Vercel's edge doesn't for `application/x-ndjson`).

**How it connects to the other concept files.** DNS/routing (file 02) answers "how did we get to this map's origins?" TCP/sockets (file 03) answers "what's holding these connections open?" TLS (file 04) answers "who terminates which hop?" HTTP semantics (file 05) answers "what conventions govern the headers/cookies/status codes on this map?" Streaming (file 06) answers "how does hop 1 stay open?" Timeouts (file 07) answers "when does the map fail?" Red flags (file 08) ranks the failure modes.

**What to read next.** If you're new to this codebase, `05-http-semantics-caching-and-cors.md` is the next file to open — most of the interesting mechanisms on this map live in HTTP-layer conventions (cookie flags, cache-control, the custom `x-bi-mcp-config` header). If you're evaluating operational risk, jump to `07-timeouts-retries-pooling-and-backpressure.md` and then `08-networking-red-flags-audit.md`.

## Interview defense

**Q: Walk me through what happens on the wire when a user clicks "investigate" on an insight.**

Three HTTPS hops in the same picture:

```
  browser ──fetch()──► /api/agent ──┬─ POST /mcp/ ────► Bloomreach
                                    └─ POST /v1/messages ► Anthropic

  response body: NDJSON stream back to browser
```

One inbound `fetch` from the browser (same-origin, cookies attached, optional `x-bi-mcp-config` header). The route opens a `ReadableStream` and starts the ReAct loop. Each loop iteration fires one Anthropic call (reasoning) and zero-to-N MCP tool calls; every one of those has an `AbortSignal.timeout(30_000)` composed with the route's cancel signal. As each call resolves, the route writes one NDJSON event to the response body. The browser's `readNdjson` kernel parses each line and dispatches to a UI handler.

Anchor: `app/api/agent/route.ts:189-215` — the multiplexer.

**Q: Why NDJSON and not SSE or WebSockets?**

NDJSON over fetch response bodies is the smallest thing that works. Same-origin, standard HTTP, no separate connection lifecycle to manage. Vercel's Node runtime doesn't support WebSockets on the standard function tier — that alone would rule them out. SSE would work (same `text/event-stream` shape) but adds framing overhead (`event:`, `data:`, blank-line delimiters) for zero benefit over NDJSON when the response is one-shot per request. One kernel (`readNdjson`) serves four consumers (briefing, investigation, capture, chat).

**Q: What's the load-bearing piece of this map — the thing that's easiest to forget but breaks everything if you remove it?**

The `AbortSignal.timeout(30_000)` composed inside `SdkTransport.callTool` (`lib/mcp/transport.ts:131`). Without it, one stuck MCP call would burn the entire 300s route budget on one tool call. The retry ladder above deliberately does NOT retry a timeout — a retry would just risk another 30s wait inside the same route budget. That "don't retry timeout" decision, plus the 30s per-call ceiling, is what keeps a single hung upstream from starving an entire investigation.

## See also

- `02-dns-routing-and-addressing.md` — how the origins on this map get resolved (URL precedence, `x-forwarded-host`)
- `05-http-semantics-caching-and-cors.md` — what conventions govern the headers/cookies/status codes on this map
- `06-websockets-sse-streaming-and-realtime.md` — why hop 1 up is NDJSON and how it stays open
- `07-timeouts-retries-pooling-and-backpressure.md` — when and how each hop fails
