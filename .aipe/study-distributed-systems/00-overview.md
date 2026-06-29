# Distributed systems — overview

## The honest framing first

This repo has **one distributed wire surface**. Everything else lives in one Node process.

```
  The whole distributed surface, in one picture

  ┌─ Browser ──────────────────────────────────────────────┐
  │  React 19 client (app/page.tsx, hooks/*)               │
  │  fetch() + NDJSON ReadableStream reader                │
  └───────────┬───────────────────────────────┬────────────┘
              │ HTTPS (same origin)           │ HTTPS (OAuth redirect, cross-site)
              ▼                               ▼
  ┌─ Vercel serverless instance (ephemeral, in-memory) ────┐
  │  /api/briefing · /api/agent · /api/mcp/{callback,…}    │
  │  in-process state: insights, investigations, schema    │
  └───────────┬───────────────────────────┬────────────────┘
              │ HTTPS (Bearer)            │ HTTPS (model API)
              ▼                           ▼
  ┌─ Bloomreach loomi-MCP ──────┐   ┌─ Anthropic API ─────┐
  │  rate limit ~1 req/s        │   │ Sonnet 4-6 + Haiku  │
  │  tokens revoked after mins  │   │ no rate limit hit   │
  └─────────────────────────────┘   └─────────────────────┘
```

That is the entire distributed surface. **Two HTTPS clients** (Bloomreach + Anthropic) called from a serverless function, plus the OAuth round-trip that lands the user back on `/api/mcp/callback`. No worker pool. No queue. No replication. No leader election. No second backend service speaking to a third.

The asymmetry between the two clients is the lesson:

- **Bloomreach** is the *interesting* upstream. Alpha-grade behavior — ~1 req/s global per-user rate limit, tokens revoked after minutes, error envelopes carrying parseable retry hints. This is where partial-failure, idempotency, backpressure, and reconnect actually bite. The repo's distributed-systems vocabulary lives in `lib/data-source/bloomreach-data-source.ts:121` and `lib/mcp/transport.ts:103`.
- **Anthropic** is the *boring* upstream. No rate limit hit at this volume; just latency variance and the per-route Vercel deadline. The 300s `maxDuration` (`app/api/agent/route.ts:22`, `app/api/briefing/route.ts:19`) is the only real concern.

The synthetic data source (`lib/data-source/synthetic-data-source.ts:314`) is **not** a distributed surface — it's an in-process function call behind the same port (`DataSource`). Listed here so you don't go hunting for a wire.

## What this repo actually exercises

Ranked by how load-bearing each pattern is in the running system.

### 1. Partial failure + retry against a per-user rate-limited upstream (load-bearing)

The kernel: the rate-limit-aware MCP client (`BloomreachDataSource.callTool`) proactively spaces calls at ~1.1s (`lib/data-source/bloomreach-data-source.ts:130`), parses the server's stated penalty window from rate-limit error envelopes (`parseRetryAfterMs`, line 64), and retries up to 3 times with `Math.min(hintMs + 500, retryCeilingMs)` — capped at 20s because the route only has 300s total.

Every other distributed concern in the repo orbits this one mechanic.

→ See `02-partial-failure-timeouts-and-retries.md`

### 2. Response cache as deduplication layer (load-bearing)

60s TTL keyed by `${name}:${JSON.stringify(args)}` (`lib/data-source/bloomreach-data-source.ts:144`). Idempotent reads (the bootstrap orchestrator: `list_cloud_organizations` → `list_projects` → schema fetches) hit the cache on the second request. Errors are deliberately **not** cached (`line 179`) — so a transient failure doesn't poison subsequent reads.

This is the repo's only deduplication mechanism. Combined with the bootstrap chain, it's what makes a re-run cheap.

→ See `03-idempotency-deduplication-and-delivery-semantics.md`

### 3. NDJSON streaming with cooperative cancellation (load-bearing)

`/api/briefing` and `/api/agent` return a `ReadableStream` of newline-delimited JSON. `req.signal.aborted` is checked at every phase boundary and threaded down to the MCP transport's `AbortSignal.timeout(30_000)` (`lib/mcp/transport.ts:38`). The two signals are composed with `AbortSignal.any` (`lib/mcp/transport.ts:173`) — first one to fire wins.

→ See `06-queues-streams-ordering-and-backpressure.md`

### 4. CSRF / OAuth state in an encrypted cookie (load-bearing in prod)

Vercel's serverless model says **the `/connect` request and the OAuth `/callback` may land on different instances**. So PKCE verifier + DCR client info + tokens can't live in process memory. The fix: an AES-256-GCM encrypted `bi_auth` cookie, read at request start, flushed at request end via `AsyncLocalStorage` (`lib/mcp/auth.ts:86`). In dev it falls back to a gitignored file; in tests, an in-memory Map.

→ See `07-clocks-coordination-and-leadership.md` (the "split-instance state" subsection)

### 5. Per-session reconnect on token revocation (load-bearing)

The alpha Bloomreach server revokes tokens after minutes. When an NDJSON error matches `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`, the client posts `/api/mcp/reset`, drops the auth cookie, and reloads — **guarded by a `sessionStorage` flag** so a permanently-failing call can't loop (`lib/hooks/useReconnectPolicy.ts:33`).

→ See `02-partial-failure-timeouts-and-retries.md`

## What is `not yet exercised` (honest)

These are real distributed-systems concepts. None are in this repo. Each gets a short Case B file so you know what they'd look like and when they'd start mattering.

| concept | status | when it would matter |
|---|---|---|
| Replication / partitioning / quorums | not yet exercised | If "demo snapshot in JSON" became a real datastore. Today: `lib/state/demo-insights.json`. |
| Sagas / transactional outbox | not yet exercised | If recommendations triggered side-effects in Bloomreach (create scenario, publish campaign) and we needed to roll back partial writes. Today: agents only **propose** actions. |
| Message queues / streams (Kafka, Redis Streams) | not yet exercised | If briefing scans were fanned out to workers. Today: one request → one stream → one upstream. |
| Leader election / distributed locks | not yet exercised | If the schema bootstrap needed to run exactly once across instances. Today: per-instance memoization via `cached` (`lib/mcp/schema.ts:190`); duplicate work tolerated. |
| Eventual consistency / CRDTs | not yet exercised | If two users edited the same investigation. Today: investigations are per-session and write-once. |
| Vector clocks / Lamport timestamps | not yet exercised | If ordering across instances mattered. Today: ordering is per-stream, per-request. |

The audit (`09-distributed-systems-red-flags-audit.md`) ranks the real risks — not these.

## Reading order

The files are numbered as a curriculum. Read top-down.

1. `01-distributed-system-map.md` — the picture above, with every boundary labelled and named.
2. `02-partial-failure-timeouts-and-retries.md` — Bloomreach's rate-limit retry ladder. The load-bearing pattern.
3. `03-idempotency-deduplication-and-delivery-semantics.md` — the 60s response cache as a dedup layer.
4. `04-consistency-models-and-staleness.md` — what "stale" means when you cache for 60s.
5. `05-replication-partitioning-and-quorums.md` — Case B; not exercised, here for the vocabulary.
6. `06-queues-streams-ordering-and-backpressure.md` — NDJSON streaming + backpressure via the ReadableStream contract.
7. `07-clocks-coordination-and-leadership.md` — the encrypted-cookie state pattern (the real distributed-state move) + Case B for leadership.
8. `08-sagas-outbox-and-cross-boundary-workflows.md` — Case B; not exercised, here so you can defend the choice.
9. `09-distributed-systems-red-flags-audit.md` — ranked risks grounded in actual files.

## The through-line

**What remains correct when coordination crosses a boundary and any participant can be slow, duplicated, stale, or unavailable?**

In this repo, the boundary is Bloomreach. The participants that can fail are: the OAuth IdP (token revoked), the MCP server (rate-limited, timed out, 401), the Anthropic API (slow), the Vercel function (cold start, 300s ceiling), and the browser tab (closed mid-stream). Every concept file below is one slice of that single question.

## See also

- `../study-system-design/` — the architectural shape (the seams, the layers, the request flow).
- `../study-database-systems/` — datastore-local consistency. The 60s cache lives here only as a dedup mechanic; the *engine* lessons live in study-database-systems.
- `../study-runtime-systems/` — the event loop and AbortController plumbing that the cancellation pattern hangs on.
- `../study-networking/` — HTTPS, OAuth, NDJSON-over-fetch; the protocol layer underneath this guide.
