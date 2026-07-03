# Distributed Systems — Overview

*Applied study guide, blooming_insights repo.*

Distributed systems audits **correctness across coordination boundaries** — what stays true when a participant can be slow, duplicated, stale, or unavailable. This repo's answer is small on purpose: **one live distributed surface**, HTTPS to an MCP server, plus one in-process synthetic adapter, plus a fault-injection decorator that lets you play out failure modes offline without running the real thing.

The rest of the "distributed" vocabulary (replicas, quorums, sagas, leader election, event streams) is **not yet exercised**. Naming that plainly matters more than pretending otherwise — see the audit at the end of this file.

## The whole system in one picture

```
  Blooming insights — coordination boundaries

  ┌─ Browser ──────────────────────────────────────────────┐
  │  Next.js UI · SSE reader                                │
  │  localStorage[bi:mcp_config] · x-bi-mcp-config header   │
  └─────────────────────────┬───────────────────────────────┘
                            │  HTTPS  (SSE / NDJSON stream)
  ┌─ Vercel Function ───────▼───────────────────────────────┐
  │  app/api/agent/route.ts   maxDuration=300s              │
  │  ┌─ AptKit agent loop ─────────────────────────────────┐│
  │  │  DiagnosticAgent / RecommendationAgent /            ││
  │  │  QueryAgent  →  callTool(...)                       ││
  │  └───────────────────┬─────────────────────────────────┘│
  │                      │  DataSource port                 │
  │  ┌───────────────────▼────────────────┐                 │
  │  │  McpDataSource (Bloomreach preset) │←── seam ──┐     │
  │  │  · spacing gate  minIntervalMs=1100│           │     │
  │  │  · retry ladder  max 3, cap 20 s   │           │     │
  │  │  · 60 s response cache             │           │     │
  │  │  · no-cache-on-error               │  swap in  │     │
  │  └───────────────┬────────────────────┘  offline: │     │
  │                  │  StreamableHTTP        Synthetic│    │
  │                  │  transport              +Fault  │    │
  │                  │  AbortSignal.timeout    Inject  │    │
  │                  │  (30_000)                       │    │
  └──────────────────┼─────────────────────────────────┼────┘
                     │  HTTPS   Anthropic API          │
                     │  (streamable-http + OAuth)      │
  ┌─ External (one)  ▼───────────────────────────┐   in-process
  │  MCP server                                   │   (Synthetic)
  │  · Bloomreach loomi (default preset)          │
  │  · or any URL supplied via UI/env             │
  │  · OAuth 2.1 + PKCE + DCR, or Bearer, or none │
  └───────────────────────────────────────────────┘
```

One box crosses a network boundary in production: **the MCP server**. Everything above it (agent loop, data-source port, retry ladder, cache) runs inside a single Vercel function invocation. Everything below the transport line is either the LLM provider (Anthropic, treated as a fetch endpoint, not as a coordinated peer) or a local decision made from what the MCP call returned.

## The concepts, ranked by how load-bearing they are here

Not every distributed-systems concept applies to a repo with one hop out. Presented in the order they actually govern this codebase:

  1. **Coordination map** — one hop out, one function invocation, one authenticated session. The whole distributed surface fits on a napkin. → `01-distributed-system-map.md`

  2. **Partial failure, timeouts, retries** — the load-bearing block. `AbortSignal.timeout(30_000)` per call, `AbortSignal.any(...)` composition, spacing gate, retry ladder that parses the server's stated window, no-cache-on-error. This is where the correctness lives. → `02-partial-failure-timeouts-and-retries.md`

  3. **Idempotency and delivery semantics** — one hop, at-most-once semantics for tool calls (the loop doesn't invocation-retry), duplicate absorption via the 60 s response cache. Named honestly: the model retries a *concept*, not the transport. → `03-idempotency-deduplication-and-delivery-semantics.md`

  4. **Consistency and staleness** — the only shared datum is the 60 s response cache, which is instance-local and per-key. No cross-instance replication of anything. → `04-consistency-models-and-staleness.md`

  5. **Replication, partitioning, quorums** — **not yet exercised.** No replicas, no partitions. Explained here so you know when it becomes relevant. → `05-replication-partitioning-and-quorums.md`

  6. **Queues, streams, ordering, backpressure** — the SSE/NDJSON response stream is the closest thing; there is no message broker. Backpressure is one-way through `req.signal` cancellation. → `06-queues-streams-ordering-and-backpressure.md`

  7. **Clocks, coordination, leadership** — **not yet exercised** at the system layer. `Date.now()` bounds the spacing gate and the cache TTL; that's a monotonic-per-instance clock, not distributed time. → `07-clocks-coordination-and-leadership.md`

  8. **Sagas, outbox, cross-boundary workflows** — **not yet exercised.** No multi-service writes, no compensating transactions. The two-step diagnose → recommend flow is a *client-side* handoff via `sessionStorage`, not a saga. → `08-sagas-outbox-and-cross-boundary-workflows.md`

  9. **Red flags audit** — ranked risks grounded in the code. Top of the list: the 60 s response cache is instance-local and never shared, and the auth cookie is the only store that survives across Vercel function instances. → `09-distributed-systems-red-flags-audit.md`

## Where this fits

- Datastore-local consistency (cache TTL semantics, the auth cookie's crypto, the demo/investigations JSON file) → `study-database-systems`.
- Architectural shape (Next.js layering, agent orchestration, feature-level partitioning) → `study-system-design`.
- Wire mechanics (HTTP/SSE framing, OAuth token exchange, DNS, TLS handshake) → `study-networking`.

The partition line for this file is coordination correctness: what remains true when a call to the MCP server times out, hits a 429, or returns garbage. That's what these nine concepts answer.

## Reading order

1. Start with **01-distributed-system-map** — the whole coordination picture.
2. Then **02-partial-failure-timeouts-and-retries** — the load-bearing mechanism.
3. Then **03-idempotency-deduplication-and-delivery-semantics** — how the "retry" story actually works given the model-in-the-loop shape.
4. **04-consistency-models-and-staleness** and **06-queues-streams-ordering-and-backpressure** are the two other applied files.
5. **05, 07, 08** are shorter — they name what's absent and when it becomes relevant.
6. Close with **09-distributed-systems-red-flags-audit** — the risk ranking.

## Top finding

The biggest coordination risk in this repo has nothing to do with the MCP server going down. It's that the **60 s response cache and the in-memory investigation cache both live inside a single Vercel function instance**. Any assumption a caller makes about "we already fetched that" or "we already computed that investigation" is per-instance. On Vercel's autoscaling model that's every request potentially hitting a cold cache, and the retry ladder has to hold the line every time. The mitigation that already ships — no-cache-on-error, per-call 30 s timeout, spacing gate at 1100 ms — is doing more work than the "there's a cache" story suggests.
