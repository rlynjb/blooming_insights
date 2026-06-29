# Distributed system map

**Industry name:** system diagram / coordination map · **Type:** Language-agnostic

## Zoom out, then zoom in

Before any mechanism, let's put the whole distributed surface of this repo on one picture. The verdict first: **there is exactly one upstream wire surface that does interesting distributed-systems work** — Bloomreach. Anthropic is a second wire but it's well-behaved (no rate limit at this volume, just latency). Everything else lives inside one Node process.

```
  Zoom out — the entire distributed surface

  ┌─ Browser / UI layer ────────────────────────────────────────┐
  │  React 19 client                                            │
  │  app/page.tsx, app/investigate/[id]/page.tsx,               │
  │  lib/hooks/{useBriefingStream,useInvestigation,             │
  │             useReconnectPolicy}.ts                          │
  └────────────┬──────────────────────────────┬─────────────────┘
               │ HTTPS same-origin             │ HTTPS cross-site
               │ fetch + NDJSON reader          │ (OAuth IdP round-trip)
               ▼                               ▼
  ┌─ Service layer — Vercel serverless (ephemeral) ─────────────┐
  │  app/api/briefing · app/api/agent ·                         │
  │  app/api/mcp/{callback, reset, call, tools, capture}        │
  │                                                             │
  │  per-instance in-memory state:                              │
  │  • lib/state/insights.ts  (session-scoped Map)              │
  │  • lib/state/investigations.ts                              │
  │  • lib/mcp/schema.ts `cached`  (schema memoization)         │
  │  • bi_auth cookie  (encrypted, cross-instance state)        │ ◄── here be dragons
  └────────────┬──────────────────────────────┬─────────────────┘
               │ HTTPS Bearer                  │ HTTPS Bearer
               │ @modelcontextprotocol/sdk     │ @anthropic-ai/sdk
               │ StreamableHTTPClientTransport │
               ▼                               ▼
  ┌─ Provider layer ────────────┐   ┌─ Provider layer ─────────┐
  │  Bloomreach loomi-MCP        │   │  Anthropic API           │
  │  https://loomi-mcp-alpha…    │   │                          │
  │  rate limit ~1 req/s         │   │  no rate limit hit       │
  │  tokens revoked ~minutes     │   │  latency variance only   │
  │  alpha-grade behavior        │   │  the "boring" upstream   │
  └──────────────────────────────┘   └──────────────────────────┘
```

The dragon icon is where the only genuinely *distributed* state lives — see `07-clocks-coordination-and-leadership.md`.

## Structure pass

Three layers (Browser → Vercel function → external providers), one axis worth tracing across them, and the boundary where the axis-answer flips is the load-bearing seam.

### Axis: who can fail and how loudly?

```
  Trace the "failure" axis down the stack

  ┌─ Browser ──────────────────────────────────┐
  │  fails by: tab closed, fetch aborted        │   → silent on server
  │           (we honor it with req.signal)     │
  └────────────────────┬───────────────────────┘
                       │
  ┌─ Vercel function ──▼───────────────────────┐
  │  fails by: 300s deadline (maxDuration),     │   → loud (route returns 500)
  │           cold start, process restart       │
  │           — all per-instance, never replicated
  └────────────────────┬───────────────────────┘
                       │
  ┌─ Bloomreach ───────▼───────────────────────┐
  │  fails by: 429 rate-limited, 401 invalid_   │   → loud + structured
  │           token, request timeout, alpha     │     (error envelope w/ hint)
  │           "fetch failed" intermittents      │
  └────────────────────────────────────────────┘
```

The axis-answer changes at every layer. That makes each boundary a **seam** worth studying.

### Seams (the boundaries where contracts live)

```
  Three seams, each with a contract

  Browser ◄── seam 1: NDJSON stream + signal.aborted ──► Vercel function
                       contract: server checks aborted
                       at every phase boundary; client
                       can hang up any time

  Vercel function ◄── seam 2: encrypted cookie ──► Vercel function (different instance)
                       contract: state survives the
                       per-instance boundary by riding
                       the user's cookie

  Vercel function ◄── seam 3: MCP Bearer + JSON-RPC ──► Bloomreach
                       contract: ~1 req/s, 60s cache
                       absorbs repeats, retry honors
                       the stated penalty window
```

Seam 2 is the surprising one. Without it (i.e. if state lived in the process), the OAuth `callback` request would land on an instance that had never seen the PKCE verifier and the flow would silently break. The encrypted cookie is the only thing making this distributed-systems problem disappear.

### The layered decomposition

```
  Layer · who owns state? · how does failure travel?

  Browser           — owns: route, sessionStorage stash, UI state
                    — failure: aborts the fetch (cooperative)

  Vercel instance   — owns: in-mem maps (per session), schema cache
                    — failure: 500 + log line; next request gets fresh instance

  Vercel cohort     — owns: NOTHING coherent across instances
                    — except the bi_auth cookie, which is what makes the
                      cohort look like a single backend to the user

  Bloomreach MCP    — owns: per-user rate-limit window, OAuth tokens
                    — failure: error envelope + structured retry hint
```

Hand off to How it works.

## How it works

### Move 1 — the mental model

You know how when you `fetch('/api/data')` from a React component the browser doesn't care which server instance answers? Same thing here, with one twist: there's an OAuth round-trip that takes the browser **away** from your server (to Bloomreach's IdP) and brings it back to a `/callback` URL, and that callback request **might** land on a different Vercel instance than the one that started the flow. So state has to ride the cookie, not the process.

The map you're learning to read has three bands — browser, your serverless functions, external providers — and four seams (NDJSON streams, OAuth, MCP-over-HTTPS, Anthropic API). The shape of the system fits on one page because there's only one interesting upstream and no internal services.

```
  Coordination map — the kernel

       ┌──────────┐   stream    ┌──────────────┐  bearer  ┌────────────┐
       │ browser  │ ◄──────────► │ Vercel fn    │ ◄──────► │ Bloomreach │
       │ (1 tab)  │              │ (N instances)│          │ (1 server) │
       └──────────┘              └──────┬───────┘          └────────────┘
                                        │ bearer
                                        ▼
                                 ┌────────────┐
                                 │ Anthropic  │
                                 └────────────┘

  state that crosses an instance boundary: ONLY the bi_auth cookie
  state in process memory: insights, investigations, schema cache
```

### Move 2 — walk the seams

#### Seam 1: browser ↔ Vercel function (NDJSON + abort)

The contract is asymmetric: the **server** opens a `ReadableStream`, the **client** reads NDJSON lines one at a time. When the user navigates away, the fetch is aborted and `req.signal.aborted` flips on the server.

```
  Layers-and-hops — what travels in each direction

  ┌─ Browser ──────┐   hop 1: GET /api/briefing?mode=… (open stream)
  │  fetch().body  │ ────────────────────────────────────────────────►
  │  reader        │                                            ┌─ Vercel fn ─────┐
  │                │   hop 2: NDJSON lines (workspace, coverage_item, │ ReadableStream  │
  │                │           reasoning_step, tool_call_*, insight…  │ controller      │
  │                │ ◄──────────────────────────────────────────────── │                 │
  │                │   hop 3 (anytime): tab closed → fetch abort       │ req.signal      │
  │                │ ────────────────────────────────────────────────► │ .throwIfAborted │
  └────────────────┘                                            └─────────────────┘
```

The server does the right thing here: `req.signal.throwIfAborted()` is called at every phase boundary in `/api/briefing` (`app/api/briefing/route.ts:215, 248, 259, 283`) and `/api/agent` (`app/api/agent/route.ts:226, 237, 248, 274, 290`). Every async layer below threads the signal down — `bootstrap(req.signal)`, `dataSource.listTools({signal})`, agent.scan({signal}), and eventually `BloomreachDataSource.callTool(..., {signal})`. **First signal to fire wins.**

#### Seam 2: Vercel instance ↔ Vercel instance (cookie-backed state)

This is the load-bearing one. Vercel's serverless functions are *ephemeral and horizontally scaled*. The `/api/mcp/connect`-equivalent (the call that triggers OAuth) and the `/api/mcp/callback` (the IdP's return) **may land on different instances**.

```
  Layers-and-hops — the OAuth round-trip across instances

  ┌─ Browser ──────┐   hop 1: GET /api/briefing
  │                │ ──────────────────────────────────► ┌─ Vercel inst A ─┐
  │                │                                     │ DCR: register   │
  │                │                                     │ PKCE: gen verif │
  │                │                                     │ saveCodeVerif() │
  │                │                                     │ saveClientInfo()│
  │                │   hop 2: 401 + authUrl + Set-Cookie │  → bi_auth cookie
  │                │ ◄────────────────────────────────── │    (encrypted)  │
  │                │                                     └─────────────────┘
  │                │   hop 3: redirect to Bloomreach IdP
  │                │ ──────────────────────────────────► (external)
  │                │   hop 4: IdP → /api/mcp/callback?code=…
  │                │ ──────────────────────────────────► ┌─ Vercel inst B ─┐ (different!)
  │                │                                     │ read bi_auth    │
  │                │                                     │ AsyncLocalStor… │
  │                │                                     │ → has verifier  │
  │                │                                     │ exchange code   │
  │                │                                     │ saveTokens()    │
  │                │                                     │ → cookie updated │
  └────────────────┘                                     └─────────────────┘
```

Real code lives in `lib/mcp/auth.ts:86`:

```ts
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();   // dev/test: file/memory
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);            // ALS scope for the request
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {…});
  }
  return result;
}
```

The `AsyncLocalStorage` is the load-bearing detail. Without it, every `provider.saveCodeVerifier(v)` / `provider.tokens()` call inside the SDK's auth flow would re-read the cookie and Next's request-vs-response cookie split would hand back the *old* value mid-request. The ALS-scoped store reads the cookie **once** at request start and flushes **once** at request end.

#### Seam 3: Vercel function ↔ Bloomreach (rate-limited HTTPS)

The interesting one. Lives in `lib/data-source/bloomreach-data-source.ts` and `lib/mcp/transport.ts`.

```
  Layers-and-hops — one tool call

  ┌─ Vercel fn ────────┐  hop 1: callTool(name, args, {signal})
  │ agent loop         │ ─────────────────────────────────────►  ┌─ BloomreachDataSource ─┐
  │                    │                                          │ cache.get(key)?         │
  │                    │  hop 2: cache hit → {result, fromCache}  │ ── yes → return         │
  │                    │ ◄─────────────────────────────────────── │ ── no  → liveCall       │
  │                    │                                          └────────────┬────────────┘
  │                    │                                                       │ wait until lastCallAt + 1100ms
  │                    │                                                       ▼
  │                    │                                          ┌─ SdkTransport ─────────┐
  │                    │                                          │ AbortSignal.any(        │
  │                    │                                          │   route signal,         │
  │                    │                                          │   timeout(30_000))      │
  │                    │                                          └────────────┬────────────┘
  │                    │                                                       │
  │                    │                                                       │ HTTPS / Bearer
  │                    │                                                       ▼
  │                    │                                          ┌─ Bloomreach loomi-MCP ─┐
  │                    │                                          │ 200 OK or 429 or 401   │
  │                    │                                          │ envelope w/ retry hint │
  │                    │                                          └─────────────────────────┘
```

This seam carries every distributed-systems concern in this repo: timeouts, retries, deduplication, backpressure, partial-failure containment. The deep walk is in `02-partial-failure-timeouts-and-retries.md`.

### Move 3 — the principle

**Most "distributed systems" advice assumes you have a topology to defend.** This repo has a topology you can fit in one diagram. The lesson isn't "we don't need distributed systems thinking" — it's that the load-bearing concerns collapse onto exactly the boundaries where the topology *does* fan out: the per-instance ephemeral memory inside Vercel's cohort, and the per-user rate limit on the upstream. Everything else is single-process and stays that way.

The map is the contract. Once you can draw it, every later file is a slice of one boundary on it.

## Primary diagram

```
  The full coordination map — every box, every arrow, every layer

  ┌─ UI layer ────────────────────────────────────────────────────────┐
  │  React 19 client                                                  │
  │  app/page.tsx · app/investigate/[id]/page.tsx                     │
  │  hooks: useBriefingStream, useInvestigation, useReconnectPolicy   │
  └────────┬─────────────────────────────────┬────────────────────────┘
           │ HTTPS NDJSON                     │ HTTPS (OAuth IdP redirect, cross-site)
           │ fetch().body + reader            │
           ▼                                  ▼
  ┌─ Service layer — Vercel serverless cohort (N ephemeral instances) ─┐
  │                                                                    │
  │  /api/briefing             /api/agent           /api/mcp/callback  │
  │     │                         │                     │              │
  │     └─── ReadableStream ──────┴────── (NDJSON) ─────┤              │
  │                                                     │              │
  │  per-instance memory:                       cross-instance state:  │
  │  • insights/investigations Maps             • bi_auth cookie       │
  │  • schema cache (lib/mcp/schema.ts:190)       (AES-256-GCM)        │
  │  • BloomreachDataSource cache (60s TTL)     • bi_session cookie    │
  │                                                                    │
  └────────┬───────────────────────────────────────┬───────────────────┘
           │ MCP-over-HTTPS                          │ HTTPS
           │ ~1 req/s spacing                        │
           │ retry honors stated penalty             │
           ▼                                         ▼
  ┌─ Bloomreach loomi-MCP ─────────────┐   ┌─ Anthropic API ────────────┐
  │  alpha — rate limit + token revoke │   │  Sonnet 4-6 + Haiku 4-5    │
  └────────────────────────────────────┘   └────────────────────────────┘
```

## Elaborate

The shape comes from three deliberate choices:

1. **Stateless serverless instead of a long-running server.** Vercel's model. Cheap, scales without thought, but ephemeral memory means any state that has to span requests either rides a cookie or doesn't exist. The encrypted-cookie OAuth store is the *only* place in this repo that solves a real distributed-systems problem.

2. **One upstream of record (Bloomreach).** No microservices, no fan-out, no internal queues. This is honest — adding a second backend you also call would multiply the boundary count.

3. **In-process synthetic source as a fallback.** The in-process implementation (`SyntheticDataSource`, `lib/data-source/synthetic-data-source.ts:314`) is *not* a wire — it's a class behind the same port (`DataSource`). Calls have `fromCache: false` and a small `durationMs` because they're function calls, not network calls. This is the "what would change if we swapped upstreams" answer.

Useful adjacent reading: Werner Vogels on eventual consistency, AWS Lambda's cold-start lifecycle, the MCP spec for the JSON-RPC envelope shape.

## Interview defense

**Q: "Walk me through your system's distributed surface."**

> "One real wire surface — HTTPS to Bloomreach's loomi-MCP server, which is rate-limited at ~1 request per second per user and revokes OAuth tokens after a few minutes. A second wire to Anthropic for model calls, but that one's well-behaved at our volume. Everything else is single-process inside Vercel serverless functions. The interesting distributed-systems work is in three places: the rate-limit retry ladder against Bloomreach, the NDJSON streaming with cooperative cancellation, and an encrypted cookie that carries OAuth state across Vercel instances because the connect-request and the callback-request can land on different ephemeral instances."

Diagram you sketch:

```
  Browser ──► Vercel fn (N) ──► Bloomreach (rate-limited, alpha)
                  │
                  └──► Anthropic
```

**Q: "What is the load-bearing seam?"**

> "Cookie-backed cross-instance state. Without it, the OAuth callback could land on an instance that never saw the PKCE verifier. The fix is `AsyncLocalStorage` plus an AES-256-GCM encrypted cookie — see `lib/mcp/auth.ts:86`. Drop that and the prod auth flow silently breaks on any cold start that lands callback on a fresh instance."

**Q: "What's NOT distributed in this codebase?"**

> "Almost everything. The synthetic data source is in-process. The insights and investigations maps are per-instance per-session. There's no message queue, no worker pool, no replica set, no leader election. I deliberately scoped the surface tight — the only distributed bit is the one our upstream actually forces us to handle."

## See also

- `02-partial-failure-timeouts-and-retries.md` — the deep walk of seam 3.
- `06-queues-streams-ordering-and-backpressure.md` — the deep walk of seam 1's NDJSON contract.
- `07-clocks-coordination-and-leadership.md` — the deep walk of seam 2's cookie-backed state.
- `09-distributed-systems-red-flags-audit.md` — ranked risks across all three seams.
