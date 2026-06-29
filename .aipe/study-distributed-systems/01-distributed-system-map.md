# Distributed system map

*Industry standard — the coordination map (nodes, boundaries, messages, ownership, failure domains).*

## Zoom out — where the coordination lives

Most of the diagrams in the rest of this guide will zoom into *one* boundary, because there's only one that matters. Here's the whole picture once, so you see why.

```
  blooming_insights — the four boxes and the one wire that matters

  ┌─ Browser ───────────────────────────────────────────────────────┐
  │  React component  →  fetch('/api/briefing?demo=cached|mode=…')   │
  │  ★ THIS IS A CONSUMER ★                                          │
  └─────────────────────────────┬───────────────────────────────────┘
                                │  hop A: HTTPS · NDJSON · same origin
                                │  (route ↔ browser — not a true
                                │   distributed seam: same trust zone,
                                │   one writer, one reader, no replay)
  ┌─ Vercel serverless ─────────▼───────────────────────────────────┐
  │  Next.js 16 App Router · per-request stream · maxDuration = 300s │
  │  ┌───────────────────────────────────────────────────────────┐   │
  │  │ /api/briefing  →  MonitoringAgent                         │   │
  │  │ /api/agent     →  Diagnostic + Recommendation + Query      │   │
  │  │ /api/mcp/*     →  callback, call, tools, reset, capture    │   │
  │  └────────────────────────────┬──────────────────────────────┘   │
  │                               │                                  │
  │  ┌─ DataSource (port) ────────▼──────────────────────────────┐   │
  │  │ • BloomreachDataSource (adapter)   → ★ DISTRIBUTED ★      │   │
  │  │ • SyntheticDataSource (adapter)    → in-process, ZERO     │   │
  │  └────────────────────────────┬──────────────────────────────┘   │
  └───────────────────────────────┼──────────────────────────────────┘
                                  │  hop B: HTTPS + OAuth Bearer
                                  │  ★ THE ONE DISTRIBUTED CALL ★
                                  │  rate limit · token revocation · 30s ceiling
                                  ▼
                ┌─ Bloomreach loomi connect MCP ──┐
                │  https://loomi-mcp-alpha.…/mcp   │  ← we don't own it
                │  Streamable HTTP transport       │     opaque internals
                └──────────────────────────────────┘
```

Hop B is the only wire where everything you've ever read about distributed systems can bite you: the other side can be slow, the token can expire mid-flight, the rate limit can reject you, the connection can hang. The other arrows are colocated state, same-origin streams, or in-process function calls.

## Zoom in — the question this map answers

The audit question for any distributed system is: *which nodes, talking over which wires, owning what state, can fail in what way?* This file lays the map flat so the next eight files can stop redrawing it and just zoom into the parts that matter.

## Structure pass — read the skeleton before the mechanics

Before the next file walks failure handling, name the skeleton with three primitives you already know.

### Layers

Four layers stacked top-to-bottom. Each one is a different trust zone, a different process boundary, or both.

```
  Layers — top to bottom · process and trust boundaries

  ┌─ L1: Browser ─────────────────────────────────┐
  │  user-trusted code, untrusted environment      │
  │  state: sessionStorage (per-tab), DOM           │
  └────────────────┬───────────────────────────────┘
                   │  HTTPS, same-origin
                   ▼
  ┌─ L2: Vercel route (per-request, ephemeral) ────┐
  │  our code, ephemeral function instance          │
  │  state: in-memory Maps (per-instance, scoped    │
  │   by sessionId), AsyncLocalStorage (per-req)    │
  └────────────────┬───────────────────────────────┘
                   │  in-process call (DataSource port)
                   ▼
  ┌─ L3: DataSource adapter (per-request object) ──┐
  │  our code, one instance per HTTP request        │
  │  state: response cache (60s), lastCallAt (spacing)│
  └────────────────┬───────────────────────────────┘
                   │  HTTPS + OAuth Bearer (the wire)
                   ▼
  ┌─ L4: Bloomreach MCP (opaque) ──────────────────┐
  │  someone else's code, someone else's SLOs       │
  │  state: workspace data, rate-limit window,      │
  │   issued/revoked OAuth tokens                   │
  └────────────────────────────────────────────────┘
```

The seam that matters is **L3 ↔ L4** — that's where every distributed-systems property lives. L1↔L2 is same-trust-zone streaming. L2↔L3 is one function call.

### The axis — failure containment

We pick *failure containment* as the axis to trace, because it makes the boundaries pop. Trace one question across the stack: **if a failure originates here, who sees it?**

```
  One axis — "if a failure originates here, who sees it?"

  L1: Browser           failure stays at L1 — a malformed JSON line is
                        swallowed (lib/streaming/ndjson.ts onMalformed default)
                        and the rest of the stream keeps coming.

  L2: Route             failure becomes an NDJSON `error` event the browser
                        renders as a panel; AbortError from a closed tab is
                        suppressed (app/api/agent/route.ts:308).

  L3: Adapter           failure becomes McpToolError with the tool name + the
                        real server body (bloomreach-data-source.ts:203).
                        Result envelopes with isError stay in-line so the
                        agent loop can decide what to do.

  L4: Bloomreach        failure shows up as either a rate-limit envelope
                        (we retry), a 401 (we surface authUrl + reset),
                        a 30s hang (we cancel and tag HTTP 0: timeout),
                        or a 5xx (we propagate as McpToolError).
```

The axis flips at **L3↔L4** — below the seam, "failure" is somebody else's incident; above it, failure is our route's job to classify, contain, and surface. That's the load-bearing joint.

### Seams — where axes flip

There are three boundaries on the map. Only one is load-bearing on the failure axis.

```
  Three boundaries, one load-bearing seam

  L1 ↔ L2  (browser ↔ route)
  ─────────────────────────
  axis (failure):       same-origin, same-trust, no axis flip
  contract:             NDJSON over ReadableStream
  load-bearing?         NO — colocated, no partial failure to contain

  L2 ↔ L3  (route ↔ DataSource)
  ─────────────────────────────
  axis (failure):       same process, exceptions just propagate
  contract:             DataSource interface (callTool, listTools)
  load-bearing?         NO — but the port DOES let us swap to Synthetic
                        and erase the distributed surface entirely

  L3 ↔ L4  (DataSource ↔ Bloomreach)
  ──────────────────────────────────
  axis (failure):       wire — partial failure is real on both sides
  contract:             MCP protocol over Streamable HTTP + OAuth
  load-bearing?         YES — THE seam where every distributed-systems
                        property lives
```

`L2 ↔ L3` is interesting in a different way — it's a *swap seam* (the port), which is what lets `SyntheticDataSource` answer the same calls in-process and erase the L4 dependency for tests and demos. The port doesn't carry distributed-systems weight; it carries optionality weight.

## How it works — the moving parts behind the map

There aren't many. That's the point.

### Move 1 — the mental model

The repo's coordination story is just one HTTPS dependency:

> **There is one place this codebase coordinates with something it doesn't own — `BloomreachDataSource.callTool` — and every distributed-systems property in the audit traces back to that one method.**

If you internalize that, the rest of the guide is a tour of how that single method handles partial failure (file 02), keeps reads safe to retry (file 03), and survives credential rotation (file 07).

```
  The single coordinating method — the kernel

  agent ──► dataSource.callTool(name, args, { signal })
              │
              ▼
            ┌──────────────────────────────────────────┐
            │  BloomreachDataSource.callTool           │
            │    1. cache lookup (60s, in-memory)       │
            │    2. liveCall:                           │
            │         a. proactive spacing (~1.1s)      │
            │         b. transport.callTool(…, signal)  │  ← HOP B
            │         c. rate-limit retry (parsed hint) │
            │    3. cache write-on-success only         │
            └──────────────────────────────────────────┘
```

Five steps. Two of them touch the wire. That's the whole thing.

### Move 2 — the parts of the map, walked

#### The four nodes, named with what each owns

You already know layered systems — controller / view / model / database is the same shape. Here each layer owns one kind of state and one kind of failure.

```
  Each node, with its owned state + failure mode

  Browser             owns: sessionStorage (insight handoff, step stash)
                      fails: tab closes → AbortError on the inflight fetch
                             malformed NDJSON line → silently skipped

  Vercel route        owns: nothing persistent — the request scope
                      fails: 300s budget exhausted, AsyncLocalStorage
                             context torn down on response close

  DataSource adapter  owns: 60s response cache + lastCallAt timestamp
                      fails: McpToolError thrown with toolName + detail

  Bloomreach MCP      owns: workspace data, rate-limit counter, OAuth
                             tokens (issued, then sometimes revoked)
                      fails: 429-shaped error envelope; 401 invalid_token;
                             connection hang (we time out at 30s)
```

The adapter's "lastCallAt + cache" is the only piece of node state that's distributed-systems-relevant, and it's per-request — a fresh `BloomreachDataSource` per request means the spacing gate resets per request too. That's intentional: across instances, Bloomreach's own rate-limit window is the source of truth, not ours.

```
  Adapter state lives for ONE request — not shared across instances

  request 1 lands on instance A       request 2 lands on instance B
  ────────────────────────────       ────────────────────────────
  new BloomreachDataSource(…)         new BloomreachDataSource(…)
    lastCallAt = 0                     lastCallAt = 0
    cache = {}                          cache = {}
    ──► call 1: spacing wait 0ms        ──► call 1: spacing wait 0ms
    ──► call 2: spacing wait 1100ms     ──► call 2: spacing wait 1100ms

  both instances think they're under spacing — but Bloomreach
  sees them as one user, ratelimit-wise. The retry ladder is
  what catches the disagreement when it fires.
```

This is honest: the proactive spacing is a *best-effort polite-client* knob. The real source of truth for "am I over the limit" is the server's 429 — that's what `parseRetryAfterMs` reads, and that's what survives the per-instance amnesia.

The code, side by side with what it does — the place where the per-request adapter is constructed (`lib/mcp/connect.ts:94-101`):

```ts
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,    // proactive spacing — polite-client guess
    retryDelayMs: 10_000,   // fallback when no parseable retry hint
    retryCeilingMs: 20_000, // upper bound on any one wait
    maxRetries: 3,          // bounded — the route has a 300s budget
  }),
};
```

Each request runs through `connectMcp`, which builds a fresh adapter wrapping a fresh `SdkTransport`. Across instances they don't share state — and they don't need to, because Bloomreach is the authority.

#### The three wires, named with what flows over them

```
  Layers-and-hops — what each wire carries

  ┌─ L1: Browser ─┐  hop A: GET /api/briefing?mode=…    ┌─ L2: Route ─┐
  │  fetch reader │ ─────────────────────────────────►  │  Next.js     │
  │  TextDecoder  │  application/x-ndjson · `\n` lines  │  per-req     │
  └───────────────┘  ◄─────────────────────────────────  └──────┬──────┘
                     events: reasoning_step | tool_call_*       │
                              | insight | diagnosis | done      │
                              | error                            │
                                                                 │
                                                                 │ in-process
                                                                 │ TypeScript
                                                                 ▼
                                                          ┌─ L3: Adapter ─┐
                                                          │  callTool(…)   │
                                                          │  spacing+retry │
                                                          └────────┬──────┘
                                                                   │
                                                                   │ hop B: POST /mcp
                                                                   │ MCP over Streamable HTTP
                                                                   │ Authorization: Bearer …
                                                                   │ Content-Type: application/json
                                                                   ▼
                                                          ┌─ L4: Bloomreach ─┐
                                                          │ rate-limited      │
                                                          │ token-revoking    │
                                                          └───────────────────┘
```

The contract on each wire matters:

- **Hop A** speaks NDJSON. The newline-delimiter rule is what lets the reader (`lib/streaming/ndjson.ts:31-44`) split on `\n` and parse one event at a time without waiting for the whole response. One writer (the route's `controller.enqueue`), one reader (the browser's `readNdjson` loop). No fan-out, no ordering hazard.
- **Hop B** speaks the MCP protocol over HTTPS. Auth rides as a `Bearer` header on every call. The SDK handles the request shaping; our `SdkTransport` (`lib/mcp/transport.ts:123`) wraps it with two things: a captured-body holder (so error bodies survive the SDK's generic `Unauthorized`) and a 30s `AbortSignal.timeout` composed with the route's cancel signal.

#### The two failure domains, named with what they share

```
  Failure domains — what fails together

  Domain 1: our code (L1+L2+L3)
  ─────────────────────────────
  A bug here breaks every request on every instance.
  Containment: tests, the AbortSignal.timeout 30s ceiling,
  the AsyncLocalStorage-scoped auth store (so requests
  don't share OAuth state), the session-keyed Maps (so
  requests don't bleed insights into each other).

  Domain 2: Bloomreach MCP (L4)
  ──────────────────────────────
  A Bloomreach incident degrades every live request
  simultaneously. We do not own this domain.
  Containment from our side:
    - bounded retry (maxRetries=3) so a single call
      can't burn the entire route budget
    - per-call 30s timeout so a hung call fails fast
    - cache-on-success-only so an error doesn't poison
      future requests
    - 401 detection → return needsAuth+authUrl, so the
      UI can re-auth instead of looping
```

The boundary between the two domains is the only honest place to put a circuit breaker, and the repo doesn't have one — see `09-distributed-systems-red-flags-audit.md` for whether that's a real gap or a deferred decision.

### Move 3 — the principle

Most "distributed systems" worry comes from coordinating with things you don't own. The disciplined move is to *count your distributed surfaces*, then put every coordination mechanism (retry, timeout, cache, error classification, cancel) at the boundary of the smallest one. This repo has exactly one such surface, and the entire distributed-systems story lives in two files (`bloomreach-data-source.ts` + `transport.ts`). That's not a missing feature; that's the right shape for the problem.

## Primary diagram — the recap

The map, all on one frame:

```
  blooming_insights — full coordination map

  ┌─ L1 Browser ──────────────────────────────────────────────┐
  │  React · fetch + reader · sessionStorage · DOM             │
  └─────┬─────────────────────────────────────────────────────┘
        │  hop A · HTTPS · NDJSON · same origin
        ▼
  ┌─ L2 Vercel route (300s · per-request) ────────────────────┐
  │  Next.js · AsyncLocalStorage auth store · req.signal       │
  │  state: session-keyed Maps (insights, anomalies)           │
  └─────┬─────────────────────────────────────────────────────┘
        │  in-process · DataSource port (the swap seam)
        ▼
  ┌─ L3 DataSource adapter (per-request instance) ────────────┐
  │  cache(60s) · lastCallAt · retry ladder · McpToolError     │
  │  Bloomreach adapter (real wire) OR Synthetic (zero wire)   │
  └─────┬─────────────────────────────────────────────────────┘
        │  hop B · HTTPS + OAuth · MCP · ★ THE distributed seam ★
        ▼
  ┌─ L4 Bloomreach loomi connect MCP (opaque) ────────────────┐
  │  rate-limited · token-revoking · we don't own it           │
  └───────────────────────────────────────────────────────────┘

  failure-axis flip:
    L1↔L2: no flip      (same origin, no partial failure)
    L2↔L3: no flip      (same process, exceptions propagate)
    L3↔L4: HARD FLIP    (the wire — everything happens here)
```

## Elaborate

The "one distributed surface" shape is increasingly common in modern web products: a same-origin frontend talking to a serverless backend that talks to one external API. Two patterns worth knowing for that shape:

- **Adapter pattern (Gang of Four) / hexagonal architecture (Cockburn).** The `DataSource` port is the canonical move — it lets you erase the distributed surface in tests (the Synthetic adapter) without changing a line of agent code. The same shape lets you add a second adapter later (e.g. for a cached/proxied Bloomreach mirror) without rewriting the agents.
- **Bulkhead (Release It! — Nygard).** Each Vercel request gets its own `BloomreachDataSource` instance. A slow Bloomreach response can't share spacing state with a parallel request — they each see their own 1.1s gate. The bulkhead here is *the request itself*. (No process-wide pool, no shared backpressure — which is fine when each request has its own time budget and the upstream rate limit is global anyway.)

Where this gets harder later: if the repo grows a second distributed dependency (Anthropic itself is one — every Claude call is also over HTTPS), the "one surface, one file" discipline starts to need more structure. Today every Claude call rides through `@anthropic-ai/sdk` directly inside the agents, not through a DataSource-style port. That's a deferred call, not a bug — see `09-distributed-systems-red-flags-audit.md` for the Anthropic-as-a-distributed-surface discussion.

## Interview defense

### "Walk me through the request/response path for a live briefing."

The browser opens a `fetch('/api/briefing?mode=live-bloomreach')`. Vercel boots (or reuses) an instance and runs `app/api/briefing/route.ts`. Inside the stream, the route calls `makeDataSource('live-bloomreach', sid)` which runs `connectMcp(sid)` — that hits the encrypted cookie via `withAuthCookies` (AsyncLocalStorage-scoped), reconstructs the OAuth provider, opens a Streamable HTTP transport to `https://loomi-mcp-alpha.bloomreach.com/mcp`, and wraps it in a `BloomreachDataSource` with `minIntervalMs: 1100`. The route then runs the monitoring agent, whose every tool call goes `agent → DataSource.callTool → SdkTransport.callTool → MCP wire → Bloomreach`. Each event the agent emits is encoded as one NDJSON line and pushed into the `ReadableStream` controller. The browser's reader splits on `\n` and dispatches each event into the React state. When the agent finishes, the route sends `{ type: 'done' }`, closes the controller, and the connection drops.

```
  Briefing — actor sequence

  Browser ──fetch──► Route ──bootstrap()──► BloomreachDS ──HTTPS──► Bloomreach
                       │
                       │ (per agent step)
                       ▼
                    Anthropic.messages.create (NOT through the DataSource port today)
                       │
                       ▼
                    DataSource.callTool ──HTTPS──► Bloomreach
                       │
                       ▼
                    controller.enqueue(NDJSON line) ──HTTPS──► Browser reader
```

*Anchor:* `app/api/briefing/route.ts:208-288` is the body of the stream's `start` callback — every coordinated thing in the request happens there.

### "How many distributed surfaces does this system have?"

One that the repo *talks about* as distributed (Bloomreach via the DataSource port), and one that the repo treats as just-a-dependency (Anthropic). The honest answer is two — but only the first one has the spacing+retry discipline around it; Anthropic's reliability is taken on faith. If Anthropic 429s or 5xxs, the agent loop will surface it as an error event and the request fails fast. Whether to retry-or-bulkhead the Anthropic call is a deferred decision — see file 09 for why it's defensible today and what would change it.

*Anchor:* `lib/agents/base.ts` is empty of distributed-systems machinery — it just hands the `Anthropic` instance into the AptKit adapters, which call it directly. Contrast with `lib/data-source/bloomreach-data-source.ts:139` where every cross-process concern is concentrated.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the spacing gate, retry ladder, and 30s timeout in detail.
- `04-consistency-models-and-staleness.md` — the global schema cache and what makes it dangerous.
- `07-clocks-coordination-and-leadership.md` — how OAuth state survives the cross-instance gap.
- `09-distributed-systems-red-flags-audit.md` — ranked risks against this map.
- `.aipe/study-system-design/` — the architectural shape behind this distributed surface.
