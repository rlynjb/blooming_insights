# 01 — Request flow

**Industry name:** streaming request/response over NDJSON with per-request configuration transport. *Type: Industry standard.*

## Zoom out, then zoom in

Every screen in this app is one of three flows: monitoring feed, investigation
step 2, investigation step 3. All three ride the same shape — a browser fetch,
a Next.js route handler that decodes mode + config, a data source, an agent
loop, and NDJSON events streaming back. This file walks that shape end to end.

```
  Zoom out — where request-flow sits in the whole system

  ┌─ UI layer (SPA) ──────────────────────────────────────────────┐
  │  page.tsx / investigate  → useBriefingStream / useInvestigation│
  │  ★ initiates fetch, attaches config header ★                  │
  └────────────────────────────┬──────────────────────────────────┘
                               │  HTTPS + cookie + x-bi-mcp-config
  ┌─ Service layer (route) ────▼──────────────────────────────────┐
  │  /api/briefing  · /api/agent                                  │
  │  parseLiveMode → decodeConfigHeader → makeDataSource →        │
  │  bootstrapSchema → agent.run() → stream(AgentEvent)           │
  └────────────────────────────┬──────────────────────────────────┘
                               │  DataSource.callTool
  ┌─ Data source layer ────────▼──────────────────────────────────┐
  │  McpDataSource (Bloomreach preset) | SyntheticDataSource      │
  │  | FaultInjectingDataSource decorator                          │
  └────────────────────────────┬──────────────────────────────────┘
                               │  MCP over HTTP · Anthropic API
  ┌─ Provider layer ───────────▼──────────────────────────────────┐
  │  MCP server (configured URL)   ·   Anthropic API              │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** Two hops matter. The first is **browser → route** — it
carries three things per request: the session cookie, the `?mode=`
query param, and the new **`x-bi-mcp-config`** header carrying a
base64-encoded `McpConfigOverride`. The second is **route → data
source**, where the factory picks the adapter. The whole rest of the
system hangs on these two decisions being made before any streaming
starts. That's why the route decodes both before it commits to a
stream — a bad auth or a missing config can still return JSON with a
proper status code; once the stream starts, it's NDJSON all the way.

## Structure pass

Three layers (browser · route · data source) and one axis worth
holding constant: **who owns the request-scoped decision at each
layer?**

```
  One question, held down the layers — "who decides at this altitude?"

  ┌─ Browser ────────────────────────────────────────────────┐
  │ decides:  which mode (bi:mode), which MCP config          │
  │           (bi:mcp_config), whether to auto-reconnect      │
  └──────────────────────┬───────────────────────────────────┘
                         │  seam: HTTP + cookie + config header
  ┌─ Route ──────────────▼───────────────────────────────────┐
  │ decides:  parseLiveMode(?mode=) branch,                   │
  │           decodeConfigHeader(header) validity,            │
  │           when to return JSON vs commit to NDJSON stream  │
  └──────────────────────┬───────────────────────────────────┘
                         │  seam: makeDataSource(mode, sid, override)
  ┌─ Data source ────────▼───────────────────────────────────┐
  │ decides:  cache hit/miss, spacing gate, retry ladder     │
  │           behavior on rate-limit / server error          │
  └──────────────────────────────────────────────────────────┘
```

The two seams — HTTP + config header (browser→route) and
`makeDataSource` (route→data source) — are where the answers flip.
Above the first seam, the browser owns preferences; below it, the
route owns validation and streaming. Above the second seam, the
route thinks about modes; below it, the data source thinks about
tool calls and rate limits. That flip is what makes each seam
load-bearing.

## How it works

### Move 1 — the mental model

You've written a fetch handler that returns JSON. Same shape here,
with two twists: the response is a stream of newline-delimited JSON
events (not one payload at the end), and the request carries an
extra header the route decodes before it decides what to do. The
pattern:

```
  Pattern — decode-then-commit

  browser ──── fetch(url, { headers: { config }, signal }) ────►
                                                                 │
                        route handler                             │
                        ┌──────────────────────────┐             │
                        │ 1. auth: cookie → session │             │
                        │ 2. mode: parseLiveMode()  │             │
                        │ 3. config: decodeHeader() │             │
                        │ 4. datasource: factory    │             │
                        │ ─── commit to stream ──── │             │
                        │ 5. bootstrap schema       │             │
                        │ 6. agent.run(streaming)   │             │
                        │ 7. for each AgentEvent:   │             │
                        │       send NDJSON line    │             │
                        └──────────────────────────┘             │
  browser ◄── stream of AgentEvent lines, terminated by 'done' ───┘
```

The commit-to-stream boundary is the key move. Anything that can
fail with a status code (401 for OAuth, 500 for setup) has to
happen *before* the `ReadableStream` starts. Once the stream is
open, all the client can do is show the accumulated events plus a
final `{ type: 'error' }` if something blew up mid-flight.

### Move 2 — step by step

**Step 1: the browser builds the request.** The feed hook reads
`bi:mode` from localStorage, reads `bi:mcp_config` from localStorage
(via `persistedConfigHeader()`), and posts to
`/api/briefing?mode=<mode>`. The config header only rides when the
user set an override.

```ts
// lib/hooks/useInvestigation.ts:187-192
const mcpHeader = persistedConfigHeader();
const res = await fetch(`/api/agent?mode=${mode}&step=${step}`, {
  method: 'POST',
  headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : undefined,
  body: JSON.stringify(payload),
  signal: abort.signal,
});
```

Two things worth noting here. First, `persistedConfigHeader()`
returns `null` when nothing is persisted — the header simply isn't
attached, and the route falls through to env config. Second, the
`AbortSignal` from the hook rides all the way through: if the user
navigates away, `abort.abort()` cancels the reader, which cancels
the underlying `fetch`, which cancels the in-flight tool call.

**Step 2: the route validates before it streams.** Both routes do
the same three-step check.

```ts
// app/api/briefing/route.ts:163-192  (equivalent block at
//   app/api/agent/route.ts:161-186)
const mode: LiveMode = parseLiveMode(req.nextUrl.searchParams.get('mode'));
const mcpConfigOverride = decodeConfigHeader(req.headers.get(BI_MCP_CONFIG_HEADER));

let sid: string;
let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
try {
  sid = await getOrCreateSessionId();
  dsResult = await makeDataSource(mode, sid, mcpConfigOverride);
} catch (e) {
  // setup errors return JSON, not NDJSON
  return NextResponse.json({ error: '...' }, { status: 500 });
}
if (!dsResult.ok) {
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
```

`parseLiveMode` maps unknown / missing values to `'live-synthetic'`
(the new default) and accepts `'live-bloomreach'` as a legacy alias
that normalizes to `'live-mcp'`. `decodeConfigHeader` returns
`null` for missing or malformed headers — deliberate: a bad header
can't crash the request.

**Step 3: the factory picks the adapter.** For `live-synthetic`,
the factory constructs a `SyntheticDataSource` immediately and
returns a bootstrap function that returns the hardcoded schema.
For `live-mcp`, it calls `connectMcp(sid, override)`, which owns
the transport handshake and the auth-provider selection. If OAuth
tokens are missing, `connectMcp` returns `{ ok: false, authUrl }`
and the route responds with 401 — that's why this happens before
the stream commits.

```
  Layers-and-hops — the request path, first half (validate)

  ┌─ Browser ─────────┐  hop 1: POST + cookie + x-bi-mcp-config
  │  useBriefingStream│ ────────────────────────────────────────►
  └───────────────────┘                                          │
                                                                 ▼
                                                   ┌─ /api/briefing ─┐
                                                   │ parseLiveMode   │
                                                   │ decodeConfig    │
                                                   │ getSessionId    │
                                                   │ makeDataSource  │
                                                   └──────┬──────────┘
              hop 2 (validation failed):                  │ hop 3 (ok):
              401 { needsAuth, authUrl } as JSON          │ ReadableStream
              500 { error } as JSON                       │ begins
              ◄────────────────────────────────           │
                                                          ▼
                                                    Move 2 step 4
```

**Step 4: bootstrap runs inside the stream.** Once the stream
starts, the very first agent-side call is `bootstrap(req.signal)`.
For `live-mcp`, this is `bootstrapSchema(mcpDs, { signal })`
(`lib/data-source/index.ts:114`) — it runs
`list_cloud_organizations` → `list_projects` → `get_event_schema`
→ `get_customer_property_schema` → `list_catalogs` →
`get_project_overview`, each spaced 1.1s apart. For
`live-synthetic`, it returns the hardcoded `syntheticWorkspaceSchema`
immediately. The client sees the same `{ type: 'workspace' }`
event either way.

**Step 5: the agent loop runs, streaming events per step.** The
route wraps the agent's callbacks so that every `reasoning_step`,
`tool_call_start`, `tool_call_end`, and terminal event
(`insight`, `diagnosis`, `recommendation`) becomes one NDJSON line
on the wire. The producer contract is `AgentEvent` at
`lib/mcp/events.ts:4-12`.

**Step 6: cancellation propagates.** `req.signal.throwIfAborted()`
is called at coarse phase boundaries inside the stream
(`app/api/briefing/route.ts:220`). The same signal rides into
every async layer — bootstrap, `dataSource.callTool`,
`anthropic.messages.create`. Whichever fires first (client cancel
or the per-call 30s timeout) cancels in-flight work.

**Step 7: the client parses each line.** The browser reads the
`ReadableStream`, decodes bytes as UTF-8, buffers on `\n`, JSON-
parses each complete line, and dispatches on `event.type`. That
kernel is shared across four consumers.
→ see `05-streaming-ndjson.md`

### Move 3 — the principle

Streaming responses trade "one atomic answer" for "the user sees
what's happening as it happens" — but that trade only works if
the request layer is honest about *when* the commit happens.
Everything that can fail with a status code has to happen before
the first byte of the stream is written; everything after that
has to be recoverable in-band via a terminal `error` event. Any
system that streams progress and doesn't hold this discipline
ends up with unrecoverable half-streams the client can't
distinguish from a real problem.

## Primary diagram

```
  Full request-flow recap — one insight fetched end to end

  ┌─ Browser ────────────────────────────────────────┐
  │  useBriefingStream                                │
  │  reads:  bi:mode  ·  bi:mcp_config (localStorage) │
  │  attaches: session cookie · x-bi-mcp-config       │
  └───────┬───────────────────────────────────────────┘
          │  fetch('/api/briefing?mode=live-mcp', { signal })
          ▼
  ┌─ Next route ─────────────────────────────────────┐
  │  parseLiveMode('live-mcp')                        │
  │  decodeConfigHeader('x-bi-mcp-config') → override │
  │  getOrCreateSessionId() → sid                     │
  │  makeDataSource('live-mcp', sid, override)        │
  │                                                   │
  │  ├── ok:false → return 401 { authUrl } as JSON    │
  │  └── ok:true  → commit to stream ↓                │
  └───────┬───────────────────────────────────────────┘
          │  ReadableStream.start()
          ▼
  ┌─ Stream body ────────────────────────────────────┐
  │  send({type:'reasoning_step', ...})               │
  │  bootstrap(req.signal)                            │
  │    → list_cloud_organizations → list_projects →   │
  │      get_event_schema → get_project_overview      │
  │  send({type:'workspace', ...})                    │
  │                                                   │
  │  agent.scan({ signal, onText, onToolCall })       │
  │    for each anomaly:                              │
  │      send({type:'insight', insight})              │
  │                                                   │
  │  send({type:'done'})                              │
  └───────┬───────────────────────────────────────────┘
          │  application/x-ndjson, chunked
          ▼
  ┌─ Browser (readNdjson kernel) ────────────────────┐
  │  for each line: JSON.parse → onEvent              │
  │  update React state per event.type                │
  └──────────────────────────────────────────────────┘
```

## Elaborate

The commit-to-stream discipline shows up in a bunch of other
places once you know to look for it — SSE endpoints in Ruby on
Rails, gRPC-streaming servers, WebSocket handshakes. The
underlying idea is the same: reserve status codes for things
you can decide before the first byte; use in-band terminal
events for everything after.

The per-request config header is the newer piece. It's the
transport that lets one deploy behave differently for different
visitors without either forking the code or relying on server-
side per-user state. Sub-boundary of the same idea: JWT-in-
Authorization headers, feature flag headers at Netflix, tenant
headers at Vercel. The novelty for this repo is that the header
is chosen and set by the *browser* from a settings modal, then
consumed transparently by the route.

## Interview defense

**Q: Why decode the config header on every request instead of
persisting it server-side?**

A: Trust boundary. The server has no user accounts; the only
identity is a session cookie. Storing per-user config server-side
would require a real auth boundary between users. The header
transport lets a visitor own their config in their own browser
without the server needing to know who they are.

**Q: What breaks if the client omits the header?**

A: Nothing. `decodeConfigHeader(null)` returns `null`, the
factory receives `undefined`, and it falls through to env config —
exactly the pre-Session-B behavior. The header is additive.

**Q: How does cancellation propagate all the way to the MCP
server?**

A: `req.signal` from the Next.js route is threaded into
`dataSource.callTool(name, args, { signal })`. Inside
`BloomreachDataSource`, the signal is composed with the per-call
30s timeout via `AbortSignal.any(...)`. Whichever fires first
aborts the underlying `fetch`, which cancels the HTTP request to
the MCP server.

**Q: One thing everyone forgets about streaming request handlers?**

A: The commit boundary. People start streaming immediately, then
realize an auth check should have returned 401 but they're mid-
stream — so they emit an in-band `{ type: 'error' }` event and
the client shows a broken UI. Do the validation first, return the
status code if it fails, *then* commit to `ReadableStream`.

## See also

- `02-auth-boundary-and-swappable-mcp.md` — what the auth check
  in step 2 actually does
- `03-provider-abstraction-and-datasource-seam.md` — how the
  factory picks the adapter
- `05-streaming-ndjson.md` — the client-side kernel that parses
  every line
- `06-per-request-config-transport.md` — the header transport in
  depth
