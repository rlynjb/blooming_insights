# Distributed Systems — overview

The whole repo, asked one question: *what stays correct when work crosses a boundary and the other side can be slow, duplicated, stale, or unavailable?*

Most of this codebase runs in one process. The interesting part — the load-bearing part — is one boundary that crosses the wire.

## The shape — one distributed surface

```
  The blooming_insights system, drawn as distributed surfaces

  ┌─ Browser (client) ───────────────────────────────────────────┐
  │  React 19 · fetch() + ReadableStream reader · sessionStorage  │
  └─────────────────────────────┬────────────────────────────────┘
                                │ hop A: HTTPS · NDJSON stream
                                │ (route ↔ browser — same origin)
  ┌─ Vercel serverless ─────────▼────────────────────────────────┐
  │  Next.js 16 App Router · per-request stream                  │
  │  /api/briefing, /api/agent, /api/mcp/{call,callback,reset,…}  │
  │                                                              │
  │  ┌─ in-process ──────────────────────────────────────────┐   │
  │  │  agents (Claude tool-use loop) ── DataSource (port)   │   │
  │  │  state Maps (session-scoped, per-instance)            │   │
  │  │  SyntheticDataSource (zero distributed surface)       │   │
  │  └─────────────────────────┬─────────────────────────────┘   │
  └────────────────────────────┼─────────────────────────────────┘
                               │ hop B: HTTPS + OAuth · the ONE
                               │ distributed call, made by
                               │ BloomreachDataSource.callTool
                               ▼
              ┌─ Bloomreach loomi connect MCP ──┐
              │  https://loomi-mcp-alpha.…/mcp  │  ← rate limit + token
              │  (server we do not own)         │     revocation lives here
              └─────────────────────────────────┘
```

Two boundaries; one of them is the only true distributed surface.

- **Hop A — route ↔ browser.** Same origin, server-sent NDJSON over a `ReadableStream` (not a network boundary in the distributed-systems sense — it's same-process delivery to a same-origin client, and there's no other consumer to disagree with).
- **Hop B — route ↔ Bloomreach MCP.** This is the one. Different service, different operator, real wire, real auth, real rate limit, real partial failure. **Every distributed-systems property in this codebase lives behind this hop.**

Synthetic mode (`SyntheticDataSource` at `lib/data-source/synthetic-data-source.ts:314`) implements the same `DataSource` port but answers in-process — zero distributed surface.

## The ranked findings

The big one first; everything else is downstream of it.

1. **One distributed surface, and it's coordinated by exactly two mechanisms: a spacing gate and a bounded retry ladder.** `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:121`) is the only place in the codebase where partial failure is a real concern, and the mechanisms it uses to survive it — `minIntervalMs: 1100` proactive spacing, server-hint-aware retry (`parseRetryAfterMs` at :64), per-call 30s transport timeout composed with the route's cancel signal (`transport.ts:38`, `transport.ts:131`), no-cache-on-error (`bloomreach-data-source.ts:179`) — are the entire distributed-systems story. → see `02-partial-failure-timeouts-and-retries.md`.

2. **No idempotency keys; safe because the only mutation crossing the boundary is OAuth token exchange.** Every tool call is a read (`list_*`, `get_*`, `execute_analytics_eql`). The retry ladder retries `isError: true` rate-limit envelopes (`bloomreach-data-source.ts:164`) without a dedup key, and that's fine because Bloomreach reads have no duplicate-write hazard. → see `03-idempotency-deduplication-and-delivery-semantics.md`.

3. **Schema bootstrap caches across requests in module memory; the cache is global per warm instance, not per session.** `lib/mcp/schema.ts:138` (`let cached: WorkspaceSchema | null = null`) — first request on a warm Vercel instance fills it; every subsequent request on that instance returns the same workspace. This is a real distributed-systems hazard: if two users authenticate to different Bloomreach projects on the same instance, the second sees the first's cached schema. → see `04-consistency-models-and-staleness.md` and `09-distributed-systems-red-flags-audit.md`.

4. **State is session-scoped in-memory Maps, with no cross-instance coordination.** `lib/state/insights.ts:14` and `lib/state/investigations.ts:11`. Vercel scales horizontally — a follow-up request can land on a cold instance with an empty Map. The investigation flow papers over this by passing the full `Insight` through `sessionStorage` and re-resolving server-side, and the demo snapshot replays from a committed JSON file. → see `09-distributed-systems-red-flags-audit.md`.

5. **OAuth flow needs three pieces of state to survive a cross-instance gap (PKCE verifier, DCR client info, tokens), solved with an encrypted cookie + AsyncLocalStorage in production.** `lib/mcp/auth.ts:47` (the `requestStore`) seeds an in-request store from the cookie once at entry and flushes once at exit — every `OAuthClientProvider` method call hits the store, never the cookie API directly. This is the only "distributed state" mechanism in the repo. → see `07-clocks-coordination-and-leadership.md`.

6. **Streaming is one writer, one reader, no fan-out, no ordering hazard.** NDJSON over a `ReadableStream` (`lib/streaming/ndjson.ts`), terminator `\n`. The producer is the route's `controller.enqueue`; the consumer is the browser's `readNdjson` loop. No broker, no queue, no consumer group, no replay log. → see `06-queues-streams-ordering-and-backpressure.md`.

7. **Most distributed-systems machinery is `not yet exercised`.** No replication, no partitioning, no quorum, no leader election, no sagas, no transactional outbox, no message queue, no cross-region anything. The repo's distributed surface is minimal *on purpose* — it's one HTTPS dependency with one operator's rate limit on the other side. → see `05-replication-partitioning-and-quorums.md`, `08-sagas-outbox-and-cross-boundary-workflows.md`.

## Reading order

The files are in dependency order — each builds on the picture the previous one drew.

```
  the map         then partial failure        then everything downstream
  ───────         ─────────────────────       ───────────────────────────
  01-distributed-system-map
        │
        ▼
  02-partial-failure-timeouts-and-retries   ← the load-bearing file
        │
        ▼
  03-idempotency-deduplication-and-delivery-semantics
        │
        ▼
  04-consistency-models-and-staleness       ← the cached-schema hazard
        │
        ▼
  05-replication-partitioning-and-quorums   ← not yet exercised
        │
        ▼
  06-queues-streams-ordering-and-backpressure
        │
        ▼
  07-clocks-coordination-and-leadership     ← the OAuth state survival trick
        │
        ▼
  08-sagas-outbox-and-cross-boundary-workflows  ← not yet exercised
        │
        ▼
  09-distributed-systems-red-flags-audit    ← ranked risks + evidence
```

If you only have time for two, read `02` and `09`.

## Explicit `not yet exercised`

The repo is small on the distributed-systems axis. Listing the absences is part of the orientation — so you know what's *not* on the map you just looked at.

- **Replication / partitioning / quorums** — there is no datastore the repo owns. State lives in process Maps (cleared on cold start), the demo snapshot is a committed JSON file (read-only), and Bloomreach is opaque. → `05`.
- **Leader election / consensus / distributed locks** — there is no work the system claims; every request is independent. → `07`.
- **Message queues / streams / consumers / poison-message handling / backpressure** — NDJSON over a single ReadableStream is one-writer/one-reader and the only stream surface. → `06`.
- **Sagas / transactional outbox / compensating actions** — there are no multi-step distributed workflows. The recommendation agent proposes Bloomreach actions in *prose*; nothing is executed across services. → `08`.
- **Exactly-once delivery / idempotency keys** — every Bloomreach call is a read; there is no write to deduplicate. → `03`.
- **Distributed tracing / span propagation** — the per-phase `console.log` (`app/api/briefing/route.ts:317`, `app/api/agent/route.ts:331`) is the entire observability story across the one boundary. → `09`.

These are the holes in the picture — and the picture is honest about which ones are *fine to leave open* for this product shape and which are real future risks.

## Verified anchors

Every file path in this guide is grounded in the current tree as of the audit date. The two files that carry the whole distributed-systems story are:

- `lib/data-source/bloomreach-data-source.ts` — the adapter, with the spacing gate (`:130`, `:191`), retry ladder (`:164`), and cache-on-success-only (`:179`).
- `lib/mcp/transport.ts` — the SDK wrapper, with the per-call 30s timeout (`:38`), the AbortSignal composition (`:131`, `:173`), and the capturing fetch for error bodies (`:103`).

The 221-test suite passes against these mechanisms; the rate-limit retry behavior in particular is covered end-to-end in `test/mcp/client.test.ts:111-167`.

## See also

- `.aipe/study-system-design/` — architectural shape and scale tradeoffs (the wider picture this distributed surface sits in).
- `.aipe/study-database-systems/` — datastore-local consistency mechanisms (mostly `not yet exercised` here too — the repo has no datastore it owns).
- `.aipe/study-networking/` — the HTTP/TLS/transport layer underneath the one distributed call.
