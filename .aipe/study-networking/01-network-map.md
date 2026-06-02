# Network map

**Industry name(s):** system-level data-flow diagram, end-to-end on-the-wire trace
**Type:** Industry standard · Project-specific

> Every byte that crosses a network boundary in this repo, every hop labelled with what travels in which direction, every actor labelled with which layer it lives in.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This is the *whole* network surface — not a subset, the entire thing. One browser, one Next.js app deployed on Vercel, two upstreams (Bloomreach MCP, Anthropic). No internal services, no message queue, no second app. Every other file in this guide narrows into one slice of this picture; you'll come back here when you lose orientation.

```
Zoom out — every network boundary in this repo

┌─ UI ────────────────────────────────────────────────────────────────────┐
│  Browser tab                                                             │
│  app/page.tsx · lib/hooks/useInvestigation.ts · app/debug/page.tsx       │
│  fetch() + response.body.getReader()                                     │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │  hop 1 — same-origin HTTPS
                           │  GET /api/briefing[?demo=cached]
                           │  GET /api/agent?insightId=…&step=…
                           │  GET /api/mcp/callback?code=…&state=…
                           │  POST /api/mcp/call · /api/mcp/reset
                           │  POST /api/mcp/capture-demo
                           │  cookies: bi_session, bi_auth (httpOnly)
                           ▼
┌─ Service (Vercel serverless function, Node runtime) ─────────────────────┐
│  app/api/briefing/route.ts · app/api/agent/route.ts                      │
│  app/api/mcp/{call,callback,tools,reset,capture-demo}/route.ts            │
│  ★ THIS IS THE ONLY SERVER WE OWN ★                                       │
│  emits: ReadableStream<Uint8Array> · application/x-ndjson; charset=utf-8 │
└───────────────┬──────────────────────────────────┬──────────────────────┘
                │                                   │
   hop 2a — HTTPS POST /mcp/         hop 2b — HTTPS POST /v1/messages
   StreamableHTTPClientTransport     @anthropic-ai/sdk
   from @modelcontextprotocol/sdk    Bearer ANTHROPIC_API_KEY
   Authorization: Bearer <access>
   (OAuth 2.1, PKCE, DCR)
                │                                   │
                ▼                                   ▼
┌─ Provider · Bloomreach Loomi MCP ┐  ┌─ Provider · Anthropic API ─────────┐
│  loomi-mcp-alpha.bloomreach.com  │  │  api.anthropic.com                  │
│  rate-limited: ~1 req / 10 s     │  │  default sdk pool, no overrides     │
│  per-user, GLOBAL window         │  │  tool-use turns + streamed reasoning│
└──────────────────────────────────┘  └─────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: where does each byte come from, where does it go, what's it wrapped in, who's authenticated to what? The rest of the guide leans on this picture. Every file path you'll see later (`lib/mcp/transport.ts`, `lib/mcp/connect.ts`, `app/api/agent/route.ts`) lives in one of the four bands above. When a later file says "the seam between the route handler and Bloomreach," it means hop 2a.

---

## Structure pass

**Layers.** Four bands: **UI** (browser, owns no secrets, ships React + fetch), **Service** (Next.js serverless function, owns API keys + cookies + the rate-limit policy), **Provider · Bloomreach MCP** (the only data source for customer/event analytics), **Provider · Anthropic** (the LLM that drives every agent run). There is no Storage band in this map — the repo is stateless in production aside from cookies and an in-process Map cache in `McpClient`. The two filesystem reads (`lib/state/demo-insights.json`, `.investigation-cache.json`) live alongside the Service band, not in a separate storage tier.

**Axis: trust.** Trace "what can each side see or modify?" across the bands and the seams pop. **UI:** sees rendered HTML, the streamed NDJSON body, and its own cookies (the `httpOnly` ones it cannot read from JS — `bi_session`, `bi_auth`). **Service:** sees `ANTHROPIC_API_KEY`, `AUTH_SECRET`, the decrypted contents of `bi_auth` (OAuth tokens + DCR client info + PKCE verifier), every tool result the upstream returns. **Bloomreach MCP:** sees the Bearer token, the EQL query strings, our user identity inside its tenant. **Anthropic:** sees the entire conversation transcript, the tool schemas, the tool results we pass through. Each hop is a trust-boundary crossing; the right axis here is "what does the receiver gain visibility into?"

**Seams.** Four seams, two of them load-bearing.

  → **Seam 1: UI ↔ Service (hop 1).** Trust flips from "no secrets" to "all secrets." Mechanism: httpOnly cookies + same-origin browser policy. The browser carries the session+auth cookies on every same-origin request but cannot read them from JS. This is the *load-bearing* seam for end-user security.
  → **Seam 2 (load-bearing for liveness): Service ↔ Bloomreach (hop 2a).** Trust flips into a rate-limited multi-tenant provider. The 1-req-per-10s window means this seam is where every networking decision in the repo concentrates — spacing, retry, cache, parsing the wait hint out of the 429 body text. Drop the wait-hint parsing and a single burst burns the entire route budget.
  → **Seam 3: Service ↔ Anthropic (hop 2b).** Trust flips into the LLM provider. No rate limit drama here — the cost is latency (multi-second streamed tool-use turns) and dollars, not 429s.
  → **Seam 4: callback round-trip (hop 1 again, but cross-site).** When the user is bounced to Bloomreach's IdP and back to `/api/mcp/callback`, the cookies have to survive a cross-site redirect. That's why `bi_session` and `bi_auth` are `SameSite=None; Secure` in production — not for ergonomics, for liveness.

```
The four seams, ranked by what flips

  hop                    trust flip                       load-bearing?
  ──────────────────     ──────────────────────────────   ─────────────
  hop 1 (UI→Service)     no secrets → all secrets         yes (security)
  hop 2a (→Bloomreach)   our process → rate-limited LB    yes (liveness)
  hop 2b (→Anthropic)    our process → LLM provider       no (cost only)
  callback round-trip    same-site → cross-site cookie    yes (auth flow)
```

The skeleton is mapped — every other file in this guide walks the mechanics that hang off one of these seams.

---

## How it works

### Mental model

Think of it as one fetch on the way in and (usually) two fetches on the way out, with the inbound fetch held open as a long-lived response body while the two outbound fetches happen interleaved inside it.

```
The shape — one in, many out, body stays open

  browser              serverless route                     upstreams
  ┌───┐ ── GET /api/agent ──► ┌───────────────┐
  │   │                       │ open Response │  ── POST /mcp/ ───────►  Bloomreach
  │   │ ◄── chunk(line1) ──── │ + ReadableStr │  ◄── tool result ─────
  │   │                       │ controller    │  ── POST /v1/messages ►  Anthropic
  │   │ ◄── chunk(line2) ──── │ .enqueue()    │  ◄── tool_use turn ───
  │   │                       │ per event     │  ── POST /mcp/ ───────►  Bloomreach
  │   │ ◄── chunk(line3) ──── │               │  ◄── tool result ─────
  │   │                       │ ...           │  ── POST /v1/messages ►  Anthropic
  │   │ ◄── chunk("done") ─── │ close stream  │  ◄── final answer ────
  └───┘                       └───────────────┘
   ▲                                ▲
   │                                │
   └─ getReader() loop in           └─ same loop awaits two upstreams,
      useInvestigation.ts              writes a line per visible step
```

The inbound stream stays open for the full 60–115 s investigation while the outbound calls happen *inside* the producer. One TCP connection in, multiple TCP connections out, no buffering in between (we set `Cache-Control: no-cache, no-transform` to keep Vercel's edge from holding chunks).

### Move 2 walkthrough

**The inbound connection: browser → serverless function.** The browser calls `fetch(url)` with no special options. Same-origin, so cookies (`bi_session`, `bi_auth`) ride along automatically. Vercel's edge routes the request to a serverless function instance — a fresh Node process on a cold start, a warm process on a hot one. The function returns a `Response` whose body is a `ReadableStream`; the browser starts pulling from `response.body.getReader()` as soon as the headers arrive.

```
Inbound hop — same-origin fetch, cookies ride free

  Browser                       Vercel edge              Serverless function
  ────────                      ────────────             ───────────────────
  fetch('/api/agent?…')   ─►    GET /api/agent  ─►       handler reads cookies
  Cookie: bi_session=…;                                    via cookies().get()
          bi_auth=…
                          ◄─    headers + body  ◄─       new Response(stream)
                                stream open               Cache-Control: no-cache
                                                          Content-Type:
                                                          application/x-ndjson
```

The seam-1 contract: every request carries the cookies the server set, the server cannot rely on anything else (no `Authorization` header from the browser, no body parameter for auth).

**The outbound hop to Bloomreach.** Inside the function, `connectMcp(sid)` builds a `StreamableHTTPClientTransport` pointed at `mcpUrl()` (default `https://loomi-mcp-alpha.bloomreach.com/mcp/`). The SDK does the HTTP under the hood — our only insertion point is the `fetch` option, which we use to install a capturing fetch wrapper that snapshots the body of any non-2xx response so we can surface the real server error. Every actual tool call ends up as `POST /mcp/` with `Authorization: Bearer <access_token>` and a JSON-RPC body.

```
Outbound hop 2a — to Bloomreach, every call gated

  Service                                           Bloomreach
  ─────────                                          ──────────
  McpClient.callTool                                  
    │                                                
    ├─ check in-process Map cache                   
    │   hit (within TTL)? → return cached, no hop  
    │                                                
    ├─ wait if (now − lastCallAt) < minIntervalMs   ← proactive spacing
    │                                                  (1.1 s default)
    │                                                
    └─ POST /mcp/  ────────────────────────────►    JSON-RPC tool call
                   Authorization: Bearer …          
                   Content-Type: application/json   
       
       ◄── 200 + JSON body ─────────────────────    
       OR
       ◄── 200 + isError:true (rate-limit text) ─   ← Bloomreach returns 200
                                                       even on rate limit,
                                                       error sits in the body
```

The boundary that catches people: Bloomreach signals rate-limit via the JSON-RPC error envelope inside an HTTP 200, not via an HTTP 429. Our client parses the text and waits — see `07-timeouts-retries-pooling-and-backpressure.md`.

**The outbound hop to Anthropic.** Same function instance, separate fetch via the official SDK. No special configuration — we hand it the API key and the model. The agent makes one Anthropic call, that call may emit `tool_use` blocks, those blocks dispatch back through `McpClient.callTool` (a fresh hop 2a), the results come back, the agent makes another Anthropic call. So a single inbound request fans out to N×Bloomreach + M×Anthropic calls before closing.

```
Outbound hop 2b — to Anthropic, the LLM loop

  Service                                            Anthropic
  ─────────                                           ──────────
  agent.investigate(anomaly)                          
    │
    └─ loop until no tool_use blocks left:
         POST /v1/messages  ─────────────────────►   model run
                              tools=[…schemas]      
                              messages=[…history]   
           ◄── streamed response  ────────────────  
                may contain text + tool_use blocks  
         │                                          
         for each tool_use: invoke McpClient        
         (which spawns its own hop 2a)              
         then loop with the tool_result appended    
```

The shape inside one inbound request: a tree of outbound hops, not a chain.

**The callback round-trip.** When the user has no Bloomreach token, the SDK throws `UnauthorizedError` after calling our `redirectToAuthorization`. We catch it in `connectMcp`, return `{ok:false, authUrl}`, and the browser does a full-page redirect to Bloomreach's IdP. The user authenticates there, the IdP redirects back to `/api/mcp/callback?code=…&state=…` — this is a cross-site redirect (top-level navigation), which is why the `bi_session` + `bi_auth` cookies must be `SameSite=None; Secure` in production. The callback reads the session cookie, decrypts the `bi_auth` cookie to recover the PKCE verifier saved during `connect`, calls `transport.finishAuth(code)`, which exchanges the code for tokens, then 302s the user back to `/`.

```
Cross-site round-trip — why SameSite=None matters

  Browser            Our app           Bloomreach IdP
  ────────           ────────          ──────────────
  GET /              
       ◄── 401 + authUrl ──            
  navigate ─────────────────────►      authorize page
       ◄── user logs in ──────          
  GET /api/mcp/callback?code=…  ◄──    302 from IdP
  (cookies: bi_session, bi_auth)       
  ★ if SameSite=Lax, this returning    
    request may drop the cookies on    
    the cross-site redirect ★          
       ◄── 302 to / ──                  callback exchanged
                                        code → tokens
```

### Principle

The cheapest network architecture wins until something forces it to grow. Blooming insights has one app, two upstreams, no internal services, no shared cache, no message queue. The complexity that *does* exist (rate-limit dance, NDJSON streaming, cross-site cookie handling) is forced by the upstream and the user-facing latency budget, not chosen for its own sake. When you're reading the next files, keep asking "what forced this?" — every load-bearing piece traces back to one of: the 1-req-per-10s window, the 60–115 s investigation latency, or the cross-site OAuth redirect.

---

## Primary diagram

The full picture, every hop labelled. Return here when a later file leans on a hop or a seam.

```
Network map — full recap

UI band ─────────────────────────────────────────────────────────────────
┌───────────────────────────────────────────────────────────────────────┐
│  Browser (React 19 + Next.js 16 client)                                │
│  app/page.tsx · lib/hooks/useInvestigation.ts · app/debug/page.tsx     │
│  fetch + getReader() (line-buffered NDJSON parser)                     │
└─────────────────┬─────────────────────────────────────────────────────┘
                  │   hop 1: same-origin HTTPS (TLS via Vercel edge)
                  │   GET /api/{briefing,agent,mcp/*}
                  │   POST /api/mcp/{call,reset,capture-demo}
                  │   Set-Cookie / Cookie: bi_session (UUID),
                  │                         bi_auth (AES-256-GCM blob)
Service band ─────▼─────────────────────────────────────────────────────
┌───────────────────────────────────────────────────────────────────────┐
│  Vercel serverless function · Node runtime · maxDuration=300          │
│  app/api/briefing/route.ts · app/api/agent/route.ts                   │
│  Response = new Response(ReadableStream, {                            │
│    'Content-Type': 'application/x-ndjson; charset=utf-8',             │
│    'Cache-Control': 'no-cache, no-transform' })                       │
│  agents: monitoring · diagnostic · recommendation · query             │
└────────────┬─────────────────────────────────────────┬────────────────┘
             │                                          │
   hop 2a: HTTPS POST /mcp/             hop 2b: HTTPS POST /v1/messages
   @modelcontextprotocol/sdk@1.29.0     @anthropic-ai/sdk@0.99.0
   StreamableHTTPClientTransport        default global fetch
   Authorization: Bearer <oauth>        Authorization: Bearer <API key>
   Content-Type: application/json       Content-Type: application/json
   gated by McpClient: spacing 1.1 s    no spacing, no explicit timeout
   + retry 10 s up to 20 s ceiling,
   + 60 s response cache (in-process)
             │                                          │
Provider band ▼                                          ▼
┌─────────────────────────────────┐  ┌──────────────────────────────────┐
│  Bloomreach Loomi MCP (alpha)    │  │  Anthropic API                   │
│  loomi-mcp-alpha.bloomreach.com  │  │  api.anthropic.com               │
│  HTTPS only · public CA chain    │  │  HTTPS only · public CA chain    │
│  rate-limit: 1 req / 10 s        │  │  no rate-limit caveat in repo    │
│  per-user GLOBAL window          │  │                                  │
│  signals via 200 + isError       │  │                                  │
│  envelope (not HTTP 429)          │  │                                  │
└─────────────────────────────────┘  └──────────────────────────────────┘

Auxiliary cross-site round-trip — only during OAuth:
Browser → Bloomreach IdP login page → 302 → /api/mcp/callback?code=…
(cookies must survive: SameSite=None; Secure in production.)
```

---

## Implementation in codebase

### Use cases

  → **Cold load of the feed.** Browser GETs `/api/briefing`; the function calls Bloomreach to read schema + run anomaly EQL across 10 categories; Anthropic narrates per category; NDJSON streams `coverage_item`, `reasoning_step`, `tool_call_start/end`, `insight`, `done` back. ~60–115 s end-to-end in live mode.
  → **Drill into an insight.** Browser GETs `/api/agent?insightId=…&step=diagnose` (then later `…&step=recommend`); the function runs the diagnostic agent → Bloomreach (many tool calls) → Anthropic, streams the same NDJSON event shape, finally a `diagnosis` event.
  → **Cold-start OAuth.** Browser hits any route; function `connectMcp` finds no tokens, returns 401 + `authUrl`; browser navigates; user logs in at Bloomreach; Bloomreach 302s to `/api/mcp/callback?code=…`; callback exchanges code → tokens via `transport.finishAuth`; redirect to `/`.
  → **Debug tool call.** `/debug` POSTs `/api/mcp/call` with `{name, args}`; bypasses cache (`skipCache: true`); single Bloomreach POST, single JSON response.

### The four routes side by side

```
app/api/briefing/route.ts   (lines 178-265, the live path)

const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
            │
            └─ producer side of seam-1: every visible
               step from the agent becomes one NDJSON line.
               No batching — flushed the moment the agent
               emits the event.
    …
    const anomalies = await agent.scan({ onToolCall, onToolResult, onText }, runnable);
       │
       └─ the scan() awaits many hop-2a calls (rate-limited)
          and many hop-2b calls (LLM). The inbound HTTP
          connection stays open the whole time.
  },
});
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
       │
       └─ no-transform is load-bearing: without it,
          Vercel's edge may buffer/gzip-rechunk the
          stream and the UI sees nothing until the
          whole 60s run finishes.
  },
});
```

```
lib/mcp/connect.ts   (lines 66-107, the outbound transport setup)

const transport = new StreamableHTTPClientTransport(mcpUrl(), {
  authProvider: provider,         ← OAuth+PKCE+DCR via BloomreachAuthProvider
  fetch: makeCapturingFetch(httpErrors),
});                                ← every actual fetch goes through
                                     our wrapper so we can capture the
                                     body of any non-OK response and
                                     attach it to the thrown error.
const client = new Client(
  { name: 'blooming-insights', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);  ← may throw UnauthorizedError; we catch
                                     it and surface lastAuthorizeUrl so
                                     the browser does the IdP redirect.

return {
  ok: true,
  mcp: new McpClient(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,         ← proactive spacing under the 10s window
    retryDelayMs: 10_000,        ← fallback wait if 429 has no parseable hint
    retryCeilingMs: 20_000,      ← cap on ANY single retry, parsed or not
    maxRetries: 3,                ← keeps a single call from eating the route
  }),
};
```

```
lib/hooks/useInvestigation.ts   (lines 184-208, the consumer side of seam-1)

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });   ← stream:true keeps
                                                   partial UTF-8 bytes
                                                   buffered across chunks
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';                       ← the last element is
                                                   either empty (clean
                                                   line boundary) or a
                                                   partial line carried
                                                   into the next read.
                                                   THIS is the seam-2
                                                   contract in the DSA
                                                   companion file.
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line) as AgentEvent); } catch { /* malformed */ }
  }
}
```

```
app/api/mcp/callback/route.ts   (lines 5-35, the auth round-trip closer)

const code = params.get('code');
if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
const sid = await readSessionId();             ← needs bi_session to have
                                                   survived the cross-site
                                                   round-trip
if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });

try {
  await completeAuth(sid, code);                ← decrypts bi_auth, reads
                                                   the PKCE verifier saved
                                                   during connect, calls
                                                   transport.finishAuth
  return NextResponse.redirect(new URL('/', req.url));
} catch (e) {
  return NextResponse.json({ error: String(e) }, { status: 401 });
}
```

---

## Elaborate

Why is the map this small? Two pressures cancelled each other out. The user-facing pressure is "show me a live agent reasoning in real time" — that forces a streaming response, which forces NDJSON or SSE. The upstream pressure is "you get one Bloomreach call per ~10 s" — that forces a serverside rate-limiter so the client never sees a raw 429. Once you have those two, there's no need for a separate WebSocket server (NDJSON over chunked HTTP does the job in 50 lines) or a separate worker (the serverless function lives long enough at `maxDuration=300`). The architecture is small because nothing has forced it to be bigger yet.

If a second source of insights showed up tomorrow — Stripe, Mixpanel, anything — the question would be whether the rate-limit logic generalises across providers (today it parses Bloomreach-specific error text) or whether each gets its own `McpClient` instance. If real-time push events ever became a requirement (e.g. "tell me when an anomaly fires"), the missing transport is SSE or WebSocket — neither is in the repo today.

---

## Interview defense

**Q1: Walk me through a request from the user clicking "investigate" to the first visible reasoning step.**

```
Diagram-while-you-speak

  click           browser fetch          serverless          Bloomreach
  ─────           ─────────────          ──────────          ──────────
  card  ──►  GET /api/agent?...  ──►  connectMcp(sid)        
                                      McpClient ready        
                                      first stepFor()        
                                      → controller.enqueue   
            ◄── chunk(line1) ──        the line              
            getReader().read()         (no other I/O yet)    
            JSON.parse(line)           
            setItems([...])            
            React re-renders ★ ← first visible reasoning step
```

Anchor: same-origin fetch, NDJSON streamed body, `setState` per line. First chunk lands before any upstream call.

**Q2: Why NDJSON and not SSE?**

Two reasons. One, no auto-reconnect — SSE's `EventSource` auto-reconnects on disconnect, which would restart a 115 s LLM investigation from scratch (and double-charge it). Two, same fetch shape on the server (`new Response(ReadableStream, …)`) but a more flexible content type. We pay nothing for the "missing" features SSE provides because we don't want them here.

Anchor: "auto-reconnect would re-run the agent — that's a money and latency footgun." See also `06-websockets-sse-streaming-and-realtime.md`.

**Q3: What happens if the Bloomreach call hangs forever?**

It eats the whole route budget. We have no `AbortController`+`signal` on the upstream fetch, no per-call timeout, no circuit breaker. Vercel kills the function at `maxDuration=300` and the user sees no events at all unless the agent already emitted some. This is `red flag #1` in `08-networking-red-flags-audit.md`.

Anchor: "the only timeout in play is the platform's hard kill — that's a gap."

---

## Validate

  1. **Reconstruct.** Sketch the network map from memory. Label every hop with method, URL, content type, auth header. Compare against the recap diagram above.
  2. **Explain.** For each of the four seams, name what *flips* across it and one consequence of the flip.
  3. **Apply.** A reader asks "where would I add a third upstream — say, Stripe — if I wanted invoice-anomaly detection?" Point at exactly which file would gain the new transport, which agent would call it, and how the rate-limit logic would need to generalise (or not). Anchor to `lib/mcp/client.ts:79-172` and `lib/agents/`.
  4. **Defend.** Argue why this small map is the right size for the current product (not "scalable" or "good for the future" — *right for now*) and name the trigger that would force the next layer (e.g. "a second concurrent user" — what breaks?).

---

## See also

  → `02-dns-routing-and-addressing.md` — how `mcpUrl()` and `api.anthropic.com` resolve to actual sockets.
  → `04-tls-and-trust-establishment.md` — what's encrypted where.
  → `05-http-semantics-caching-and-cors.md` — the cookies and headers that hold this together.
  → `07-timeouts-retries-pooling-and-backpressure.md` — the rate-limit playbook at hop 2a.
  → `../study-system-design/05-streaming-ndjson.md` — the line-buffering contract on the wire.
