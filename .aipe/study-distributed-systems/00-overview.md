# Distributed Systems — overview

You have ONE distributed surface in this repo, and that's the whole point.
Bloomreach's `loomi-mcp-alpha` server, reached over HTTPS through the MCP
StreamableHTTP transport. The Olist SQL adapter is retired. The synthetic
adapter is in-process — no network, no partial failure. So the coordination
budget you get to spend, you spend on one boundary: the client's browser and
the Vercel serverless function on one side; Anthropic's model API and the
Bloomreach MCP server on the other.

That single boundary is where every distributed-systems concept in this repo
either lives or is honestly absent. Below is the coordination map, the
ranked findings, and the reading order.

## The coordination map — one picture

```
  The whole system, one distributed hop

  ┌─ Client (browser) ──────────────────────────────────────────────┐
  │  fetch('/api/briefing?mode=live-bloomreach')                    │
  │  fetch('/api/agent?...&step=diagnose')                          │
  │  NDJSON stream reader — parses tool_call, insight, done         │
  └────────────────────────┬────────────────────────────────────────┘
                           │  hop A · HTTPS to same-origin
                           │  cancellable (AbortController)
  ┌─ Vercel Serverless (Node) ─────▼───────────────────────────────┐
  │  app/api/briefing/route.ts   maxDuration = 300s                │
  │  app/api/agent/route.ts      maxDuration = 300s                │
  │                                                                │
  │  ReadableStream → NDJSON → req.signal composed downward:       │
  │    MonitoringAgent / DiagnosticAgent / RecommendationAgent     │
  │        │                                                       │
  │        │  hop C · Anthropic HTTPS       hop B · MCP HTTPS      │
  │        ▼                                    ▼                  │
  └───┬─────────────────────────────────────────┬──────────────────┘
      │                                         │
  ┌─ Provider ─▼──────┐              ┌─ Provider ▼──────────────┐
  │  Anthropic API    │              │  Bloomreach loomi        │
  │  claude-sonnet-4-6│              │  mcp-alpha               │
  │  claude-haiku-4-5 │              │  OAuth PKCE + DCR        │
  │                   │              │  ~1 req/s per user       │
  │  no state at ours │              │  revokes tokens after    │
  │                   │              │  minutes on the alpha    │
  └───────────────────┘              └──────────────────────────┘

  layer boundaries labelled: Client · Serverless · Provider (2)
  data-flow direction: request down, NDJSON up, tool-call out and back
```

Three hops. Every distributed-systems mechanism in this repo hangs off one
of them. `hop A` is same-origin browser→function. `hop B` is where all the
interesting failure is (rate limits, token revocation, timeouts, malformed
JSON — the Bloomreach hop is why `BloomreachDataSource` exists). `hop C` is
the Anthropic hop and it's the quietest one — cost management, retry-on-5xx
by the SDK, that's about it.

## The ranked findings

You get one ranked list because a flat tour teaches less. Here's the order,
with the file that walks each in full.

### #1 — the load-bearing thing: partial failure at hop B, absorbed by the model's tool_result loop

Not by an invocation-level catch. Not by a circuit breaker. The mechanism
that keeps this system upright when Bloomreach returns malformed JSON, times
out at 30s, or 429s past three retries — it's AptKit's agent loop wrapping
the failed tool call as a `tool_result` block with `is_error: true`, then
letting the model reason about the failed call and decide whether to retry
or move on.

Proof: the Week 4B fault-injection smoke test at `FAULT_TIMEOUT=0.2
FAULT_MALFORMED_JSON=0.2 FAULT_SEED=42`, LOAD_N=3 — **9 faults injected (5
malformed_json + 4 timeouts), 0 investigations failed**. Receipt at
`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`.

The load-bearing part everyone forgets: this only works because AptKit's
run-agent-loop CATCHES the throw at
`node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js:81-86`
— if it didn't, the throw would bubble out of the agent, past the route
handler, and land on the client as an NDJSON `{type:"error"}`. The
"graceful degradation" is one try/catch in a library you don't own.

→ 02-partial-failure-timeouts-and-retries.md

### #2 — timeout composition: three signals, first-fires-wins

`req.signal` (client cancelled) is composed with `AbortSignal.timeout(30_000)`
(per-call MCP ceiling) at `lib/mcp/transport.ts:131` via `composeSignals`. The
result is a single `AbortSignal` that fires on whichever comes first. This is
the mechanism that prevents one hung Bloomreach call from burning the entire
300s route budget.

Load-bearing part: `AbortSignal.any([...])` (Node 20+) is the primitive; the
manual `AbortController`-glue fallback at `lib/mcp/transport.ts:180-188` is
belt-and-braces. If either the client abort or the 30s timeout is stripped,
a single stuck call runs to the route's 300s ceiling and takes the whole
request with it.

→ 02-partial-failure-timeouts-and-retries.md

### #3 — retry ladder that respects the server's stated window

Bloomreach 429s tell you how long to wait ("Retry after ~12 second(s)",
"rate limit reached (1 per 10 second)"). `parseRetryAfterMs` at
`lib/data-source/bloomreach-data-source.ts:64-71` reads the hint;
`callTool` at `:164-174` waits it out with `retryCeilingMs: 20_000` as
the cap and `retryDelayMs: 10_000` as the fallback base. maxRetries=3.

Load-bearing part: the `+ RETRY_BUFFER_MS` cushion at
`bloomreach-data-source.ts:49` and `:169` — retrying exactly on the boundary
of the server's stated window lands inside the window and burns another
attempt. The 500ms buffer is what keeps the retry from being self-defeating.

→ 02-partial-failure-timeouts-and-retries.md

### #4 — no-cache-on-error (circuit-breaker-adjacent)

At `lib/data-source/bloomreach-data-source.ts:179-181`: results with
`isError: true` are returned but NOT cached. The 60s response cache
absorbs repeats of successful calls; error envelopes bypass it so a
transient 401 doesn't poison the cache for a minute.

This is not a full circuit breaker — there's no half-open state, no failure
counter. It's a rule about what enters the cache. Which is exactly the
right size for a system with ONE upstream and ONE consumer per session.

→ 02-partial-failure-timeouts-and-retries.md

### #5 — proactive spacing gate (client-side rate limiting)

Bloomreach rate-limits globally per user. `BloomreachDataSource` enforces
`minIntervalMs: 1100` at construction time
(`lib/mcp/connect.ts:97`), and every call sleeps the difference between
`Date.now() - this.lastCallAt` and 1100ms
(`bloomreach-data-source.ts:190-194`). Belts before braces: the retry
ladder is the braces.

Why 1100ms specifically: the alpha server has been observed at both "1 per
1 second" and "1 per 10 second" windows. Spacing at 10s would burn ~60s on
a 6-call investigation and blow the 300s route budget. So 1100ms is the
optimistic spacing; 10s retries handle the pessimistic case.

→ 06-queues-streams-ordering-and-backpressure.md

### #6 — session as the tenant boundary

`lib/state/insights.ts:14` — `state = new Map<string, SessionFeed>()`. A
single warm Vercel instance serves multiple users concurrently; the outer
map is keyed by session id, and only the caller's sub-map is `.clear()`ed
when `putInsights` runs a new briefing (`insights.ts:57-70`). Without this,
`putInsights.clear()` would wipe another user's feed mid-briefing.

Same shape at `lib/mcp/auth.ts:34-47` — production auth is per-request
ALS-scoped from an encrypted cookie; dev/test is a per-session file / Map.

→ 04-consistency-models-and-staleness.md

### #7 — session-scoped OAuth in a stateless runtime

Vercel serverless functions are ephemeral: the connect request and the
OAuth callback request may land on different instances. The MCP SDK's
`OAuthClientProvider` needs the PKCE `code_verifier` from the connect
request to survive to the callback request. `lib/mcp/auth.ts` solves this
three different ways depending on environment:
production stores in an encrypted (AES-256-GCM) httpOnly cookie
(`auth.ts:47-104`); development stores in a gitignored file
(`.auth-cache.json`); test uses in-memory Map.

The cookie is the interesting one for distributed systems: it's how you
get "session state" without a shared store when you can't guarantee
sticky instances.

→ 07-clocks-coordination-and-leadership.md

### #8 — no queues, no streams (into the analyst)

The analyst produces one NDJSON stream OUT to the browser, but consumes
tool results synchronously. There is no message queue, no event stream
into the agents, no fan-out worker pool. This is a deliberate absence:
the shape of the product is one-user-per-investigation, and everything
runs inside the 300s route.

Where you'd feel it: if you wanted to batch Bloomreach queries across
users, or if the alpha server dropped webhook events at you, there is no
queue mechanism to consume from. `not yet exercised`.

→ 06-queues-streams-ordering-and-backpressure.md

### #9 — no replication, no partitioning, no leader election

There is no data store you own. Insights are in `Map<string,SessionFeed>`
inside one Vercel instance. Two warm instances serving the same user
each hold their own copy, and they don't reconcile — the client's
sessionStorage is what actually survives across pages
(`lib/hooks/useInvestigation.ts`). Nothing here votes, nothing has a
quorum, nothing has a follower.

→ 05-replication-partitioning-and-quorums.md

### #10 — the fault-injection subsystem itself is a distributed-systems tool

`lib/data-source/fault-injecting.ts` is a `DataSource` decorator (the same
seam as `BloomreachDataSource` and `SyntheticDataSource`) that fires four
canonical failure modes at configurable probabilities:

- `timeout` — throws `HTTP 0: timeout after 30000ms` (mimics
  `lib/mcp/transport.ts:137`)
- `rate_limit` — throws `status=429` + retry-after hint
- `server_error` — throws `status=500`
- `malformed_json` — returns a `ToolResult` with unclosed JSON in a text
  block; the downstream unwrap rejects it

Deterministic when `FAULT_SEED` set (xorshift32). This is how you exercise
the tier-2 story — the same paths that fire against real Bloomreach when
the alpha server times out or 429s — WITHOUT paying the real-network cost
or waiting for the alpha to actually misbehave.

→ 09-distributed-systems-red-flags-audit.md (Finding #1)

## Reading order

Read in this order — each file assumes the ones before it.

  01. distributed-system-map            — the coordination map in full
  02. partial-failure-timeouts-and-retries — the load-bearing findings
                                             (#1–#4 above)
  03. idempotency-deduplication-and-delivery-semantics — the 60s cache is
                                             the only dedup surface; the
                                             agent's tool-call loop is
                                             at-least-once by construction
  04. consistency-models-and-staleness  — session-scoped state, warm
                                          instances, and the sessionStorage
                                          escape hatch
  05. replication-partitioning-and-quorums — mostly `not yet exercised`;
                                             says when it becomes relevant
  06. queues-streams-ordering-and-backpressure — the spacing gate is the
                                                 only backpressure
                                                 mechanism; no queues
  07. clocks-coordination-and-leadership — OAuth session survival across
                                           ephemeral instances, no leader
  08. sagas-outbox-and-cross-boundary-workflows — the two-step
                                                   diagnose→recommend flow
                                                   as a lightweight saga
                                                   (with a rough edge)
  09. distributed-systems-red-flags-audit — ranked risks + verdicts

## What's `not yet exercised`

Named honestly here so no file below has to pad:

- **Replication / partitioning / quorums** — no owned data store
- **Leader election / consensus** — nothing votes, nothing has a term
- **Message queues / streams** — inbound is synchronous per-request;
  outbound is NDJSON to one client
- **Multi-region** — Vercel edge cache is disabled on both routes
  (`cache-control: no-store, no-transform`)
- **Sagas with compensation** — the two-step diagnose→recommend flow has a
  handoff but no compensation on step-3 failure
- **Transactional outbox** — no outbox because no DB
- **Distributed transactions** — none

## Where this partition sits

```
  distributed-systems (this)   correctness ACROSS coordination boundaries
                               → hop B (Bloomreach) partial failure
                               → hop C (Anthropic) less interesting
                               → session-as-tenant-boundary at hop A
  system-design                architectural shape and scale tradeoffs
  database-systems             datastore-local consistency mechanisms
                               (mostly `not yet exercised` — no DB)
```

Cross-links point to the neighbor rather than re-teaching.
