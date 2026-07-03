# distributed-system-map

*Coordination map · Industry standard*

## Zoom out — where this concept lives

You're about to look at your only distributed hop. Everything else in the
codebase is in-process or same-machine. The Bloomreach MCP server is the
single external system this app coordinates with, and every partial-failure
mechanism you have exists to defend that boundary.

```
  Zoom out — the whole system as layers

  ┌─ Client layer (browser) ──────────────────────────────────────┐
  │  React 19 / Next 16 app router                                │
  │  fetch() + ReadableStream reader                              │
  │  sessionStorage (per-tab investigation cache)                 │
  └───────────────────────────┬───────────────────────────────────┘
                              │  hop A — same-origin HTTPS
  ┌─ Service layer (Vercel Node runtime) ▼───────────────────────┐
  │  app/api/briefing/route.ts   maxDuration=300                  │
  │  app/api/agent/route.ts      maxDuration=300                  │
  │  lib/agents/*   (AptKit agent loop)                           │
  │  lib/data-source/*   (DataSource seam ★ THIS IS THE MAP ★)    │ ← we are here
  │  lib/mcp/*   (transport, auth, connect)                       │
  └───────┬─────────────────────────────────────────┬─────────────┘
          │  hop C — Anthropic HTTPS                │  hop B — Bloomreach HTTPS
  ┌─ Provider ▼──────────┐                ┌─ Provider ▼───────────────┐
  │  api.anthropic.com   │                │  loomi-mcp-alpha          │
  │  claude-sonnet-4-6   │                │  MCP over StreamableHTTP  │
  │  claude-haiku-4-5    │                │  OAuth PKCE + DCR         │
  │  stateless to us     │                │  ~1 req/s per user        │
  └──────────────────────┘                │  revokes tokens: minutes  │
                                          └───────────────────────────┘
```

The map you build here is the one every other file in this guide points
back to. Three hops (A, B, C), two boundaries where partial failure is real
(B and C, and B is where the interesting one lives), one place where all the
coordination logic actually is (the service layer).

## Structure pass

### Layers

Four bands, top to bottom, in the diagram above:

- **Client** — the browser. Owns the NDJSON stream reader, the mode toggle
  (`bi:mode` in localStorage), the per-tab sessionStorage escape hatch.
- **Service (Vercel Node)** — the two long routes (`/api/briefing` and
  `/api/agent`) plus the four short MCP routes. Every long-running
  coordination decision happens here.
- **Provider — Bloomreach** — the interesting external system.
  Rate-limited, alpha-quality, revokes tokens on you.
- **Provider — Anthropic** — the model API. Well-behaved, but paid by the
  token, so cost management is coordination too.

### One axis — trace it: "who owns the state that survives this hop failing?"

Not control flow. Not who-decides. STATE — because the interesting story is
which sides can lose what and how the system reconstructs it.

```
  One axis, held constant across every layer:
  "who owns the state that survives this hop failing?"

  ┌───────────────────────────────────────────────┐
  │ Client (browser)                               │
  │   owns: sessionStorage (per-tab investigation) │  ← survives page refresh
  │   owns: localStorage (bi:mode)                 │  ← survives close/reopen
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ Service (Vercel warm instance)                │
      │   owns: in-memory Map<sid, SessionFeed>       │  ← survives NOTHING
      │        (lib/state/insights.ts:14)              │    beyond one warm
      │   owns: BloomreachDataSource cache (60s)      │    instance's lifetime
      │        (bloomreach-data-source.ts:122)        │
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ Provider — Bloomreach                      │
          │   owns: OAuth tokens + PKCE state         │  ← owned by them; we
          │   owns: rate-limit window (per user)      │    remember our copy
          └───────────────────────────────────────────┘
              ┌────────────────────────────────────────┐
              │ Provider — Anthropic                    │
              │   owns: nothing about us               │  ← every request is
              │        (stateless model calls)         │    self-contained
              └────────────────────────────────────────┘
```

The answer flips at every layer. That's the load-bearing insight: the
**client is the most durable state store in this system**. sessionStorage
outlives the Vercel warm instance's in-memory Map. That's why
`useInvestigation` stashes the investigation trace in sessionStorage before
navigating to the recommend page — the alternative is "run it again on a
cold instance and hope."

### Seams — where the axis flips

Three seams matter:

- **`req.signal` / route handler seam** (hop A) — where "client owns"
  becomes "service owns." A closed tab flips `req.signal.aborted = true`,
  and every layer below reads it via `composeSignals` and stops work. This
  is where the client's "I've moved on" propagates to Bloomreach and
  Anthropic.

- **`DataSource` interface** (between service and hop B) — the abstract
  seam every agent talks to. Owns the retry ladder, the spacing gate, the
  60s cache, the malformed-JSON injection. Two production adapters
  (`BloomreachDataSource`, `SyntheticDataSource`) and one decorator
  (`FaultInjectingDataSource`) all satisfy it. **This is the seam that
  makes fault injection possible offline.**

- **OAuth `authProvider` seam** (between hop B transport and the auth
  store) — where "we own the tokens" meets "we don't own the runtime the
  tokens live in." `BloomreachAuthProvider` at `lib/mcp/auth.ts:160`
  implements the SDK's `OAuthClientProvider`; the store beneath it is
  either a cookie (prod), a file (dev), or a Map (test). The seam lets the
  MCP SDK stay ignorant of Vercel's runtime.

## How it works

### Move 1 — the mental model

You know how a `fetch()` from the browser has one hop (browser → origin)? Add
two more, one to Bloomreach and one to Anthropic, and treat them as
**independent failure domains** — each can be slow, wrong, or unavailable
without the other going down. The map is a picture of those three hops
plus the boundaries where state ownership flips.

```
  The pattern — three hops, two failure domains, one shared cancel signal

    Client                Service               Providers (2)
    ──────                ───────               ────────────
      │                     │                        ▲     ▲
      │ hop A               │                        │ B   │ C
      │  ─── fetch() ─────► │  ─── MCP ────────────► │     │
      │                     │  ─── Anthropic ────────────► │
      │                     │                        │     │
      │  ◄── NDJSON ─────── │                        │     │
      │                     │                        │     │
      │ req.signal ◄──── composed ──── hop B timeout │     │
      │                                              │     │
      └──── close tab / abort ── fires all downstream signals

    Failure domain B (Bloomreach) is the interesting one.
    Failure domain C (Anthropic) is quieter.
    Cancel travels TOP DOWN; failure travels BOTTOM UP; each is independent.
```

### Move 2 — walk the mechanism

#### The Client → Service hop (hop A)

Same-origin HTTPS. The client opens a `fetch()`, the route returns a
`ReadableStream` with `Content-Type: application/x-ndjson`, and the
client parses newline-delimited JSON. No SSE, no WebSocket — just a
long-lived HTTP response.

```typescript
// app/api/briefing/route.ts:332-335 — the wire contract
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

`no-store, no-transform` matters: any intermediary that buffers or transforms
NDJSON will destroy the "streaming reasoning" UX. Vercel's edge respects it.

The important boundary here: **`req.signal` is the client's kill switch.**
Close the tab, and it flips. Every downstream layer reads it — either
directly (`req.signal.throwIfAborted()` at
`app/api/briefing/route.ts:215, 248, 259, 283`) or via signal composition.

#### The Service → Bloomreach hop (hop B)

The interesting one. `BloomreachDataSource` at
`lib/data-source/bloomreach-data-source.ts:121` wraps a connected MCP SDK
transport and adds four coordination behaviors on top of the wire:

```
  hop B, layered — one call, four defenses

  agent.callTool('execute_analytics_eql', { eql: ... }, { signal })
                          │
                          ▼
  ┌─ BloomreachDataSource.callTool ─────────────────────┐
  │  1. cache check  (60s, keyed name+args)             │  ← dedup
  │  2. spacing gate  (sleep to hit minIntervalMs=1100) │  ← rate-limit avoid
  │  3. liveCall via SdkTransport                        │
  │       │                                              │
  │       ▼                                              │
  │  ┌─ SdkTransport.callTool (lib/mcp/transport.ts:129)│
  │  │  composeSignals(opts.signal, timeout(30_000))    │  ← 30s ceiling
  │  │  client.callTool({ name, arguments: args })      │
  │  │  catch → HTTP 0 (timeout) or HTTP N (server)     │  ← error shaping
  │  └──────────────────────────────────────────────────┘
  │                                                      │
  │  4. isRateLimited(result) check                     │  ← retry ladder
  │     while retries < 3 { parseRetryAfterMs → sleep →  │
  │        retry, cap at retryCeilingMs=20_000 }         │
  │  5. don't cache on isError                          │  ← poison-guard
  └─────────────────────────────────────────────────────┘
                          │
                          ▼
  { result, durationMs, fromCache }
```

Every layer in that stack was added because Bloomreach's alpha behaved a
specific way. `minIntervalMs=1100` because the alpha 429s at 1 req/s.
`retryDelayMs=10_000` fallback because the alpha states its penalty as "1
per 10 second" in error text. The 30s ceiling because a hung MCP call on
the alpha would burn the entire 300s route budget on one stuck call.

The load-bearing code sits at `lib/mcp/connect.ts:96-101`:

```typescript
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,
    retryDelayMs: 10_000,
    retryCeilingMs: 20_000,
    maxRetries: 3,
  }),
};
```

Those four numbers ARE the coordination contract with Bloomreach.

#### The Service → Anthropic hop (hop C)

Comparatively quiet. `AnthropicModelProviderAdapter.complete` at
`lib/agents/aptkit-adapters.ts:59` calls `anthropic.messages.create` with a
composed signal, and the Anthropic SDK does its own retry-on-5xx internally.
The only coordination logic YOU add is:

- **prompt caching** (`aptkit-adapters.ts:85-89`) — the system prompt has
  `cache_control: { type: 'ephemeral' }` set, so within a 5-minute window
  the ~10 model turns of one investigation reuse the same prefix and pay
  ~0.1× on the input tokens
- **budget tracking** (`aptkit-adapters.ts:63-66`) — before every
  `complete()`, check `BudgetTracker` and throw `BudgetExceededError` if
  the ceiling has been hit; the route catches this and emits a graceful
  `{type:"error"}` on the NDJSON

Anthropic is stateless to us. Cost is the only thing that leaks across
requests.

#### The fault-injection decorator (a fourth "hop" that isn't a hop)

`lib/data-source/fault-injecting.ts` is `DataSource`-shaped and wraps any
concrete adapter. Fault checks fire in severity order — `timeout` first,
then `rate_limit`, then `server_error`, then `malformed_json`
(`fault-injecting.ts:85-100`). The seed makes the fault sequence
reproducible via xorshift32 (`:157-166`).

The point of the decorator: **you can now exercise hop B's failure paths
without hop B**. `eval/load.eval.ts:246-260` wraps a `SyntheticDataSource`
with `FaultInjectingDataSource` when any `FAULT_*` rate is > 0, and the
same agents that would run against Bloomreach run against the
fault-injected synthetic. Week 4B smoke: 9 faults injected, 0
investigations failed
(`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`).

### Move 3 — the principle

**Draw the map before you draw the mechanism.** Every distributed-systems
lesson in this repo hangs off a hop in the diagram above. The reason the
one-page overview is a picture and not a paragraph is that once you can
point at the picture, the mechanism at each hop stops being surprising.
The corollary: if you find yourself explaining a partial-failure
mechanism and you can't point at the hop it defends, either the mechanism
is defensive noise or your map is wrong.

## Primary diagram — the whole system, one frame

```
  Full coordination map — recap

  ┌─ Client (browser) ────────────────────────────────────────────────────────┐
  │  page.tsx / investigate/*.tsx                                             │
  │  fetch('/api/{briefing,agent}?mode=live-bloomreach')                      │
  │  ReadableStream reader → NDJSON parse → UI updates                        │
  │  sessionStorage (per-tab), localStorage (mode)                            │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │  hop A: HTTPS same-origin, NDJSON out
                                  │         req.signal ← close tab / abort
  ┌─ Service (Vercel Node) ▼─────────────────────────────────────────────────┐
  │                                                                          │
  │   app/api/briefing/route.ts    │    app/api/agent/route.ts                │
  │   MonitoringAgent              │    DiagnosticAgent → RecommendationAgent │
  │           │                    │           │                             │
  │           └── AptKit agent loop (runs the model + tool calls) ──┐        │
  │                                                                 │        │
  │           ┌── DataSource seam (lib/data-source/types.ts) ◄──────┘        │
  │           │                                                              │
  │   ┌───────▼───────────┐   ┌────────────────┐   ┌────────────────────┐    │
  │   │ Bloomreach        │   │ Synthetic      │   │ FaultInjecting     │    │
  │   │ DataSource        │   │ DataSource     │   │ DataSource         │    │
  │   │ (live prod)       │   │ (offline eval) │   │ (decorator ★ NEW)  │    │
  │   └─────────┬─────────┘   └────────────────┘   └────────────────────┘    │
  │             │                                                            │
  │   ┌─ SdkTransport (lib/mcp/transport.ts:123) ─┐                          │
  │   │  composeSignals(req.signal, timeout=30s)  │                          │
  │   └─────────┬─────────────────────────────────┘                          │
  │             │                                                            │
  │   ┌─ OAuthClientProvider (BloomreachAuthProvider) ┐                      │
  │   │  cookie / file / Map (env-dependent)           │                      │
  │   └───────────────────────────────────────────────┘                      │
  └─────────────┼──────────────────────────────────────────┬─────────────────┘
                │  hop B: Bloomreach HTTPS                 │  hop C: Anthropic HTTPS
                │  StreamableHTTP MCP transport            │  api.anthropic.com
                │  OAuth PKCE + DCR                        │  claude-sonnet-4-6
                ▼                                          ▼
       ┌─ Provider (loomi) ┐                    ┌─ Provider (Anthropic) ┐
       │ ~1 req/s per user │                    │ SDK-side retry on 5xx │
       │ tokens expire ~m  │                    │ prompt cache 5min TTL │
       │ EQL execution     │                    │ paid per token        │
       └───────────────────┘                    └───────────────────────┘
```

## Elaborate

The map above is the shape you inherit when you build "one long-running
route that streams reasoning while talking to two external systems." It's
a specific archetype. Other codebases in this shape:

- ChatGPT-style app: one route, one external LLM, one same-origin stream
- Vercel AI SDK example: same shape, sometimes with a vector DB as a
  third hop
- **This app** adds a rate-limited, session-authenticated external tool
  server on hop B — which is what makes it distributed-systems-interesting

Where this pattern breaks: as soon as you add persistent state you own
(a database, a queue, a job runner), the map grows a fourth layer and
the interesting questions shift from "how do I survive hop B failing"
to "how does the database survive me failing." That layer is
`not yet exercised` here.

## Interview defense

### Q: "Walk me through the system as a distributed-systems problem."

Model answer, one diagram sketched while you speak:

```
  three hops, one interesting boundary

  browser ── HTTPS ──► vercel ──── MCP HTTPS ────► bloomreach (rate-limited)
                        │
                        └──── Anthropic HTTPS ───► claude
```

"Three hops. Client → Vercel is same-origin, streams NDJSON back. Vercel →
Anthropic is quiet — SDK handles retries, we add prompt caching and budget
tracking. Vercel → Bloomreach is the interesting one: rate-limited at
~1 req/s, alpha server revokes tokens after minutes, occasionally times
out. Everything in `lib/data-source/bloomreach-data-source.ts` exists to
defend that one boundary — spacing gate, retry ladder, 30s ceiling, no
cache on error. The DataSource interface lets us swap in a synthetic
adapter for eval and wrap either with `FaultInjectingDataSource` to
exercise those defenses offline."

### Q: "What's the load-bearing part everyone forgets?"

The one-line answer:

> **The DataSource seam.** Not the retries, not the timeout — the interface
> at `lib/data-source/types.ts:63`. Without it, `FaultInjectingDataSource`
> can't wrap `SyntheticDataSource`, and the whole "prove graceful
> degradation offline" story doesn't work. The seam is what turned a
> Bloomreach-only adapter into a testable distributed system.

Anchor: `lib/data-source/types.ts:63-71` (the interface),
`lib/data-source/fault-injecting.ts:59` (the decorator that proves it).

## See also

- 02-partial-failure-timeouts-and-retries.md — the mechanisms at hop B
- 04-consistency-models-and-staleness.md — the client-owns-state axis
- 07-clocks-coordination-and-leadership.md — the OAuth-across-instances
  problem
- `../study-system-design/audit.md` — architectural framing without the
  distributed-systems lens
