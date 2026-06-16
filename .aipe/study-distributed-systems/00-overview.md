# Overview — distributed systems in blooming insights

**Industry name(s):** coordination boundaries · partial-failure surface · stateless-server / stateful-client · heterogeneous-backend adapter
**Type:** Industry standard · Language-agnostic

> blooming insights is a **single-process Next.js app on Vercel** — no replicas you coordinate, no workers, no queues, no consensus, no leader election, no shared mutable cluster state. **What IS distributed is the boundary work**: every meaningful piece of the system crosses a hop — over the internet or over a Unix pipe — into a partner that can be slow, rate-limited, crashed, or unreachable. There are now **two distributed transports**: HTTP+SSE to the remote Bloomreach loomi-mcp-alpha server (rate-limited, OAuth-token-revoked-after-minutes, network failure modes) AND stdio to a local subprocess (no rate limit, no auth, process-crash failure modes). Both speak MCP/JSON-RPC 2.0; both implement the same `DataSource` interface; `makeDataSource(mode, sessionId)` picks one. So the distributed-systems lens here is narrow but real: **partial failure at every hop**, **stateless server / stateful client coordination** for investigation handoffs, **heterogeneous backends behind one interface**, and **the inability to coordinate across Vercel instance recycles or parallel eval runs**. The most consequential mechanism is `BloomreachDataSource`'s parse-the-server's-own-retry-window retry; the most consequential gap is that nothing in this app coordinates across instances.

---

## Zoom out — distributed surface

```
  blooming insights — distributed surface (what crosses a hop)

  ┌─ Client (browser) ───────────────────────────────────────────────────────┐
  │  React + sessionStorage  (bi:diag:<id>  bi:insight:<id>  bi:inv:*)       │
  │  ★ CARRIES STATE THE SERVER CANNOT REMEMBER ACROSS INSTANCES ★            │
  └─────────────────────────────┬────────────────────────────────────────────┘
                                │  HTTPS · cookies (bi_session + bi_auth)
                                ▼
  ┌─ Vercel instance N (Next route handler · maxDuration 300s) ──────────────┐
  │  in-memory Map (insights, investigations)  ◄── DOES NOT survive recycle  │
  │  module-cached schema (per-process)        ◄── DOES NOT survive recycle  │
  │  makeDataSource(mode, sid)  ── factory picks one of TWO adapters         │
  └─────┬───────────────┬──────────────────┬──────────────────────┬──────────┘
        │               │                  │                      │
        │ HTTPS+SSE     │ HTTPS+Bearer     │ HTTPS                │ stdio
        │ + Bearer      │ + PKCE flow      │                      │ (Unix pipe)
        ▼               ▼                  ▼                      ▼
  ┌─ Bloomreach MCP ─┐ ┌─ Bloomreach IdP ┐ ┌─ Anthropic API ─┐ ┌─ mcp-server- ─┐
  │  ~1 req/s/user   │ │  OAuth + DCR +   │ │  rate limits +   │ │  olist        │
  │  GLOBAL          │ │  PKCE            │ │  variable        │ │  (subprocess) │
  │  token revokes   │ │  partial failure │ │  latency         │ │  no auth      │
  │  after minutes   │ │  drops verifier  │ │  partial failure │ │  no rate      │
  │  HTTP+SSE        │ │                  │ │                  │ │  limit; can   │
  │  JSON-RPC 2.0    │ │                  │ │                  │ │  crash / EPIPE│
  └──────────────────┘ └──────────────────┘ └──────────────────┘ └───────────────┘
  ◄────────── live-bloomreach ──────────►                    ◄── live-sql ──►
  (BloomreachDataSource — HTTP transport)                    (OlistDataSource —
                                                              stdio transport)
```

The interesting boxes are the four external partners (three over the internet, one over a Unix pipe to a child process), plus the dashed gap above the route handler. Everything inside one Vercel invocation is single-process; everything that crosses a hop in that diagram is distributed. The two adapters speak the **same** MCP/JSON-RPC 2.0 protocol over **different** transports.

**Zoom in — what this guide covers.** Five things actually apply at the distributed-systems lens. (1) **Partial failure at external boundaries** — `BloomreachDataSource`'s retry-with-parsed-window is genuine partial-failure engineering and lives in `lib/data-source/bloomreach-data-source.ts:164-174`. (2) **Heterogeneous backends behind one interface** — `DataSource` (`lib/data-source/types.ts:64-72`) abstracts over HTTP+OAuth and stdio+subprocess; `makeDataSource(mode, sid)` (`lib/data-source/index.ts:73-109`) hides the bootstrap and dispose asymmetries. (3) **Subprocess lifecycle as a distributed primitive** — `OlistDataSource` (`lib/data-source/olist-data-source.ts:93-197`) spawns/connects/reuses/disposes a child process; one subprocess per instance; lazy connect; killed on `dispose()`. (4) **Stateless server, stateful client** — the diagnosis handoff between investigation steps is carried by the *browser* through `sessionStorage`, not by the server, precisely because Vercel might route step 3 to a different instance than step 2 (`lib/hooks/useInvestigation.ts:18-19`). (5) **No cross-instance coordination** — the in-memory `Map` in `lib/state/insights.ts:4-6` is per-process; nothing in the app reconciles two instances seeing different state — including no coordination across parallel eval-script processes, which bit the team during a K=10 race (see file 05). Consensus, replication, leader election, partition tolerance, quorum proper: **not yet exercised** — and labelled as such where it matters.

---

## Structure pass

**Layers.** Four, ordered by how much coordination they require: **client** (one browser, no peers) → **Vercel instance** (one Node process, no peers it knows about) → **transport boundary** (HTTP+SSE to MCP/Anthropic/IdP OR stdio pipe to olist subprocess) → **external system** (their own distributed internals, opaque to us). The interesting work is at the third layer: the boundary. The transport changes (network vs IPC) but the protocol — JSON-RPC 2.0 inside the MCP envelope — does not. Everything inside the first two layers is single-process; everything past the fourth is someone else's problem.

**Axis: guarantees.** Hold one question across every layer: *what does this layer promise the layer above it, and what happens when it can't keep the promise?* The client promises "I'll re-render when state changes" — strong, local. The Vercel instance promises "if I'm alive, my `Map` has what you stored" — and the silent failure is when the instance dies between requests. The DataSource layer promises "same `{result, durationMs, fromCache}` envelope regardless of which backend you're talking to" — a *uniform* promise over heterogeneous internals. The Bloomreach adapter promises "I'll retry rate-limit errors within a budget, then surface them"; the Olist adapter promises "I'll spawn the subprocess on first use, reuse it, and kill it on dispose." Both are bounded promises, the right kind for partial failure. The external systems promise only what their respective error shapes say. Guarantees weaken as you descend, and the right response is for the upper layer to know what the lower one *can't* promise.

**Seams.** Four load-bearing, one fake.

- **Seam A: client ↔ server** (browser ↔ Vercel instance). The guarantee flips from "session-local React state" to "request-local instance memory." `sessionStorage` survives this seam in both directions; in-memory `Map`s in the server do not survive *between* this seam crossings if Vercel routes you to a new instance. This is why `bi:diag:<id>` exists.
- **Seam B: route ↔ DataSource** (cosmetic — same process, same await chain). No guarantee flip. Listed here only so it's not mistaken for a distributed seam.
- **Seam C: BloomreachDataSource ↔ Bloomreach MCP** (HTTPS+SSE, rate-limited). Guarantee flips from "I'll space and retry for you" to "global ~1 req/s window, may 429 anyway." Failure mode is network: 429, 401, 5xx, hang.
- **Seam D: connect-request ↔ callback-request** (same OAuth flow, possibly different Vercel instances). Guarantee flips from "PKCE verifier saved in memory at connect-time" to "PKCE verifier must be readable at callback-time, possibly on a different instance." Solved by the encrypted `bi_auth` cookie (`lib/mcp/auth.ts:38-104`).
- **Seam F: OlistDataSource ↔ mcp-server-olist subprocess** (stdio pipe to a Node child process). Guarantee flips from "I'll spawn and reuse a child for you, with a per-call 30s timeout" to "a Node process reading SQLite over JSON-RPC frames on stdin/stdout; can crash, EPIPE, or stay silent." Failure mode is process-shaped, not network-shaped: spawn-failures, broken pipes, dead children. This is the *new* load-bearing distributed seam introduced in Phase 2.

```
  Structure pass — guarantees down the stack, two backends

  ┌─ client ─────────────────────────────────────────────┐
  │  guarantee: local React state + sessionStorage        │
  │  breaks when: tab closes (sessionStorage is per-tab)  │
  └────────────────────────┬─────────────────────────────┘
                           │  seam A — client ↔ server
                           ▼
  ┌─ Vercel instance ─────────────────────────────────────┐
  │  guarantee: in-memory Map IF instance is alive         │
  │  breaks when: cold start, recycle, or routed-to-other  │
  │               instance — silent, no error              │
  └────────────────────────┬──────────────────────────────┘
                           │  makeDataSource(mode, sid) — factory
                           │  picks ONE adapter; both implement
                           │  `DataSource` (uniform {result, durationMs,
                           │  fromCache})
                           ▼
              ┌────────────┴────────────┐
              │                         │
     seam C   ▼                         ▼   seam F
  ┌─ BloomreachDataSource ──┐  ┌─ OlistDataSource ──────┐
  │  HTTP+SSE transport      │  │  stdio (Unix pipe)     │
  │  cache + space +         │  │  AbortSignal.timeout(   │
  │    parsed-retry          │  │    30_000) PER CALL     │
  │  no per-call timeout     │  │  lazy connect; one      │
  │  budget: maxRetries=3    │  │    subprocess; reuse    │
  │  failure mode: 429,      │  │  failure mode: spawn    │
  │    401, 5xx, hang        │  │    error, EPIPE, crash  │
  └────────────┬─────────────┘  └────────────┬───────────┘
               │  HTTPS                      │  stdio frames
               ▼                             ▼
  ┌─ Bloomreach MCP ────────┐  ┌─ mcp-server-olist ─────┐
  │  ~1 req/s/user GLOBAL    │  │  Node child process     │
  │  stated in 429 text      │  │  reads SQLite read-only │
  │  token revokes ~minutes  │  │  no rate limit, no auth │
  └──────────────────────────┘  └─────────────────────────┘
```

Seam C is the original distributed seam. Seam F is the new one, with a *different* failure ontology (process vs network). Seam A matters because Vercel can't fix it for you — the client carries the state. The DataSource boundary above C/F is itself a seam where heterogeneous internals become uniform — the agent loop never has to know which backend it's talking to.

---

## How distributed systems shows up here

```
  Five things that genuinely apply at the distributed-systems lens

  1. PARTIAL FAILURE AT EXTERNAL BOUNDARIES
     BloomreachDataSource: cache + spacing + parse-the-server's-own-retry
     OlistDataSource:      per-call AbortSignal.timeout(30s) + dispose
     → file 02 (timeouts + retries), file 03 (idempotency)

  2. HETEROGENEOUS BACKENDS BEHIND ONE INTERFACE
     DataSource abstracts HTTP+OAuth (Bloomreach) and stdio+subprocess
     (Olist) behind the same callTool/listTools/dispose signature;
     makeDataSource(mode, sid) hides bootstrap and dispose asymmetries
     → file 10 (transport-agnostic protocol design)

  3. SUBPROCESS LIFECYCLE AS DISTRIBUTED PRIMITIVE
     OlistDataSource spawns the mcp-server-olist child process via
     StdioClientTransport; lazy connect on first callTool; one child per
     instance; killed on dispose(); JSON-RPC over a Unix pipe
     → file 10 (transport-agnostic protocol design)

  4. STATELESS SERVER, STATEFUL CLIENT
     useInvestigation hands the diagnosis from step 2 → step 3 via
     sessionStorage because the server cannot remember it
     → file 04 (consistency + staleness)

  5. NO CROSS-INSTANCE / CROSS-PROCESS COORDINATION
     in-memory Map in lib/state/insights.ts is per-process; two
     concurrent users on two Vercel instances see different state. The
     eval scripts hit the same hazard: parallel K=10 runs from two
     processes both write into the same eval/results/<date>/ dir
     unless EVAL_RUN_TAG suffixes them apart
     → file 05 (replication — explicitly NOT YET EXERCISED; includes
       the parallel-run anecdote), file 09 (red-flags audit)
```

Everything else on the standard distributed-systems checklist — consensus, leader election, multi-region replication, quorums, sagas, stream ordering, vector clocks, split-brain — does not apply here. The files below say so plainly where they don't, and walk the mechanism only where it does.

---

## Reading order

| # | File | Verdict |
|---|------|---------|
| 01 | distributed-system-map | The map: client, Vercel instance, four providers (MCP, Anthropic, IdP, olist subprocess). Four real boundaries (two transports), two ownership flips. |
| 02 | partial-failure-timeouts-and-retries | The load-bearing one: `BloomreachDataSource` parses Bloomreach's "Retry after N seconds" and waits exactly that long, bounded by maxRetries=3 + retryCeilingMs=20000. The Olist side has a per-call 30s `AbortSignal.timeout` — closing the per-tool-timeout gap on its own seam only. |
| 03 | idempotency-deduplication-and-delivery-semantics | All MCP tool calls are reads (idempotent by accident). The 60s TTL cache (Bloomreach side only) is the only dedup; Olist has no cache. Writes back to either backend: NOT YET EXERCISED. |
| 04 | consistency-models-and-staleness | Read-your-writes solved by the client carrying state across requests. Cross-instance: no consistency model at all. Two adapters have asymmetric staleness (60s on Bloomreach, fresh on Olist). |
| 05 | replication-partitioning-and-quorums | NOT YET EXERCISED. There's nothing replicated to coordinate. Vercel is multi-instance but the app pretends it isn't. Includes the K=10 parallel-eval race anecdote and the `EVAL_RUN_TAG` fix — shared mutable state across processes bit us for real. |
| 06 | queues-streams-ordering-and-backpressure | NDJSON streams from server → client (one-way, ordered by emission). No work queues, no backpressure beyond `ReadableStream`'s built-in. JSON-RPC frames over stdio is a different stream shape — synchronous request/response, not push. |
| 07 | clocks-coordination-and-leadership | NOT YET EXERCISED. `Date.now()` is used for cache TTLs and rate-limit spacing — all within one process, so no clock-skew problems. |
| 08 | sagas-outbox-and-cross-boundary-workflows | The two-step investigation IS a cross-boundary workflow with handoff state — but the "saga" is the user clicking "next step" with sessionStorage as the outbox. |
| 09 | distributed-systems-red-flags-audit | Top 3: cross-instance state loss, no per-tool timeout on the Bloomreach side (Olist side is fixed), no idempotency story for any future write. Subprocess-lifecycle adds RISK 10 (dispose failure). |
| 10 | transport-agnostic-protocol-design | NEW. JSON-RPC 2.0 over arbitrary transports (HTTP+SSE vs stdio); the `DataSource` interface as the heterogeneous-backend seam; the `makeDataSource` factory; subprocess lifecycle as a first-class distributed primitive. |

---

## Where this sits vs neighbors

- **`study-system-design/`** — owns architecture, scale, storage choice. It names the same in-memory-state risk; this guide explains *why* it's a distributed-systems problem (cross-instance coordination gap), not just a storage one.
- **`study-database-systems/`** — owns datastore-local consistency. Doesn't apply here (no database).
- **`study-networking/`** — owns DNS/TLS/HTTP semantics. The retry-on-429 here uses HTTP semantics that file walks.
- **`study-runtime-systems/`** — owns the event loop inside one Vercel instance. The "stateful server" failure mode lives at the boundary between *that* file (one instance) and *this* file (many instances).

Cross-link rather than re-teach.

---

Updated: 2026-06-01 — Initial generation as v1.55 distributed-systems guide (Partially Case B). Single-process app; boundaries to external services + cross-instance coordination gap are the real distributed-systems surface. Consensus / replication / leader-election explicitly NOT YET EXERCISED.

---
Updated: 2026-06-16 — Phase 2 added a SECOND distributed transport (stdio to mcp-server-olist subprocess) behind the same DataSource interface; renamed/repathed McpClient → BloomreachDataSource; added Seam F (subprocess pipe) and the heterogeneous-backend pattern; added file 10 (transport-agnostic protocol design); flagged the Phase 3 parallel-eval K=10 race as the real distributed-systems anecdote for file 05.
