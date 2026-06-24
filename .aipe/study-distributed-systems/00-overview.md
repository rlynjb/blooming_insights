# Overview — distributed systems in blooming insights

**Industry name(s):** coordination boundaries · partial-failure surface · stateless-server / stateful-client
**Type:** Industry standard · Language-agnostic

> blooming insights is a **single-process Next.js app on Vercel** — no replicas you coordinate, no workers, no queues, no consensus, no leader election, no shared mutable cluster state. **What IS distributed is the boundary work** to external services over the network: every meaningful piece of the system crosses a hop into a partner that can be slow, rate-limited, or unreachable. The **one** distributed transport is HTTP+SSE to the remote Bloomreach loomi-mcp-alpha server (rate-limited, OAuth-token-revoked-after-minutes, network failure modes); the `BloomreachDataSource` adapter implements `DataSource` and `makeDataSource(mode, sessionId)` constructs it. A second adapter, `SyntheticDataSource` (PR landed 2026-06-18), also implements `DataSource` but runs **in-process** — no IPC, no subprocess, no network — so it does not add a distributed surface. The earlier `OlistDataSource` stdio-subprocess adapter that briefly added a second distributed transport was removed in PR #8 (2026-06-18). So the distributed-systems lens here is narrow but real: **partial failure at the Bloomreach hop**, **stateless server / stateful client coordination** for investigation handoffs, and **the inability to coordinate across Vercel instance recycles**. The most consequential mechanism is `BloomreachDataSource`'s parse-the-server's-own-retry-window retry; the most consequential gap is that nothing in this app coordinates across instances.

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
  │  makeDataSource(mode, sid)  ── factory picks Bloomreach or in-proc fake  │
  └─────┬───────────────┬──────────────────┬──────────────────────────────────┘
        │               │                  │
        │ HTTPS+SSE     │ HTTPS+Bearer     │ HTTPS
        │ + Bearer      │ + PKCE flow      │
        ▼               ▼                  ▼
  ┌─ Bloomreach MCP ─┐ ┌─ Bloomreach IdP ┐ ┌─ Anthropic API ─┐
  │  ~1 req/s/user   │ │  OAuth + DCR +   │ │  rate limits +   │
  │  GLOBAL          │ │  PKCE            │ │  variable        │
  │  token revokes   │ │  partial failure │ │  latency         │
  │  after minutes   │ │  drops verifier  │ │  partial failure │
  │  HTTP+SSE        │ │                  │ │                  │
  │  JSON-RPC 2.0    │ │                  │ │                  │
  └──────────────────┘ └──────────────────┘ └──────────────────┘
  ◄────────── live-bloomreach (BloomreachDataSource) ────────►

  (live-synthetic: SyntheticDataSource runs IN-PROCESS — no IPC, no
   subprocess, no network — does not cross any distributed hop.)
```

The interesting boxes are the three external partners over the internet, plus the dashed gap above the route handler. Everything inside one Vercel invocation is single-process; everything that crosses a hop in that diagram is distributed. There is **one** distributed transport in play: HTTP+SSE to Bloomreach. The `SyntheticDataSource` adapter implements the same `DataSource` interface but is in-process — useful for local-data scenarios, not a distributed boundary.

**Zoom in — what this guide covers.** Four things actually apply at the distributed-systems lens. (1) **Partial failure at the Bloomreach boundary** — `BloomreachDataSource`'s retry-with-parsed-window is genuine partial-failure engineering and lives in `lib/data-source/bloomreach-data-source.ts:164-174`. (2) **Adapter seam for heterogeneous backends** — `DataSource` (`lib/data-source/types.ts:58-72`) abstracts the agent loop away from the concrete backend; `makeDataSource(mode, sid)` (`lib/data-source/index.ts:65-99`) chooses Bloomreach (the one real distributed adapter) or `SyntheticDataSource` (in-process fake). The interface is shaped for N adapters, but only ONE crosses a process boundary today. (3) **Stateless server, stateful client** — the diagnosis handoff between investigation steps is carried by the *browser* through `sessionStorage`, not by the server, precisely because Vercel might route step 3 to a different instance than step 2 (`lib/hooks/useInvestigation.ts:18-19`). (4) **No cross-instance coordination** — the in-memory `Map` in `lib/state/insights.ts:4-6` is per-process; nothing in the app reconciles two instances seeing different state. Consensus, replication, leader election, partition tolerance, quorum proper: **not yet exercised** — and labelled as such where it matters.

---

## Structure pass

**Layers.** Four, ordered by how much coordination they require: **client** (one browser, no peers) → **Vercel instance** (one Node process, no peers it knows about) → **transport boundary** (HTTP+SSE to Bloomreach MCP, plus HTTPS to Anthropic/IdP) → **external system** (their own distributed internals, opaque to us). The interesting work is at the third layer: the network boundary. Everything inside the first two layers is single-process; everything past the fourth is someone else's problem. The `SyntheticDataSource` adapter sits at layer 2 (in-process) — it never reaches layer 3.

**Axis: guarantees.** Hold one question across every layer: *what does this layer promise the layer above it, and what happens when it can't keep the promise?* The client promises "I'll re-render when state changes" — strong, local. The Vercel instance promises "if I'm alive, my `Map` has what you stored" — and the silent failure is when the instance dies between requests. The DataSource layer promises "same `{result, durationMs, fromCache}` envelope regardless of which backend you're talking to" — a *uniform* promise. The Bloomreach adapter promises "I'll retry rate-limit errors within a budget, then surface them"; the in-process synthetic adapter promises "I'll return deterministic fixture data, never fail for transport reasons." External systems promise only what their respective error shapes say. Guarantees weaken as you descend, and the right response is for the upper layer to know what the lower one *can't* promise.

**Seams.** Three load-bearing, one fake.

- **Seam A: client ↔ server** (browser ↔ Vercel instance). The guarantee flips from "session-local React state" to "request-local instance memory." `sessionStorage` survives this seam in both directions; in-memory `Map`s in the server do not survive *between* this seam crossings if Vercel routes you to a new instance. This is why `bi:diag:<id>` exists.
- **Seam B: route ↔ DataSource** (cosmetic — same process, same await chain). No guarantee flip. Listed here only so it's not mistaken for a distributed seam. The `SyntheticDataSource` lives entirely behind this seam and never crosses it.
- **Seam C: BloomreachDataSource ↔ Bloomreach MCP** (HTTPS+SSE, rate-limited). Guarantee flips from "I'll space and retry for you" to "global ~1 req/s window, may 429 anyway." Failure mode is network: 429, 401, 5xx, hang.
- **Seam D: connect-request ↔ callback-request** (same OAuth flow, possibly different Vercel instances). Guarantee flips from "PKCE verifier saved in memory at connect-time" to "PKCE verifier must be readable at callback-time, possibly on a different instance." Solved by the encrypted `bi_auth` cookie (`lib/mcp/auth.ts:38-104`).

```
  Structure pass — guarantees down the stack, one distributed adapter

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
                           │  picks ONE adapter
                           ▼
              ┌────────────┴────────────┐
              │                         │
     seam C   ▼                         ▼   (no distributed seam —
  ┌─ BloomreachDataSource ──┐  ┌─ SyntheticDataSource ──┐    in-process)
  │  HTTP+SSE transport      │  │  in-process JS object   │
  │  cache + space +         │  │  deterministic fixtures │
  │    parsed-retry          │  │  no transport, no IPC,  │
  │  no per-call timeout     │  │  no network             │
  │  budget: maxRetries=3    │  │  always fromCache:false │
  │  failure mode: 429,      │  │  failure mode: none     │
  │    401, 5xx, hang        │  │    (synchronous return) │
  └────────────┬─────────────┘  └─────────────────────────┘
               │  HTTPS
               ▼
  ┌─ Bloomreach MCP ────────┐
  │  ~1 req/s/user GLOBAL    │
  │  stated in 429 text      │
  │  token revokes ~minutes  │
  └──────────────────────────┘
```

Seam C is the one distributed seam at the DataSource layer. Seam A matters because Vercel can't fix it for you — the client carries the state. The DataSource boundary above C is itself a seam where the agent loop is decoupled from the concrete backend — even though only one of the two adapters today actually crosses a process boundary.

---

## How distributed systems shows up here

```
  Four things that genuinely apply at the distributed-systems lens

  1. PARTIAL FAILURE AT THE BLOOMREACH BOUNDARY
     BloomreachDataSource: cache + spacing + parse-the-server's-own-retry
     (the SyntheticDataSource adapter doesn't cross a hop, so partial
      failure is not a question there)
     → file 02 (timeouts + retries), file 03 (idempotency)

  2. ADAPTER SEAM FOR HETEROGENEOUS BACKENDS
     DataSource abstracts the agent loop from the concrete backend.
     Two adapters today: BloomreachDataSource (HTTP+OAuth — the one
     distributed adapter) and SyntheticDataSource (in-process fake).
     makeDataSource(mode, sid) chooses one. The interface is shaped
     for N adapters, but only ONE crosses a process boundary.
     → file 10 is RETIRED but kept as a record of when the interface
       briefly carried two transports.

  3. STATELESS SERVER, STATEFUL CLIENT
     useInvestigation hands the diagnosis from step 2 → step 3 via
     sessionStorage because the server cannot remember it
     → file 04 (consistency + staleness)

  4. NO CROSS-INSTANCE COORDINATION
     in-memory Map in lib/state/insights.ts is per-process; two
     concurrent users on two Vercel instances see different state.
     → file 05 (replication — explicitly NOT YET EXERCISED), file 09
       (red-flags audit)
```

Everything else on the standard distributed-systems checklist — consensus, leader election, multi-region replication, quorums, sagas, stream ordering, vector clocks, split-brain — does not apply here. The files below say so plainly where they don't, and walk the mechanism only where it does.

---

## Reading order

| # | File | Verdict |
|---|------|---------|
| 01 | distributed-system-map | The map: client, Vercel instance, three providers (MCP, Anthropic, IdP). Three real boundaries (all HTTPS), one ownership-flip gap (cross-instance). |
| 02 | partial-failure-timeouts-and-retries | The load-bearing one: `BloomreachDataSource` parses Bloomreach's "Retry after N seconds" and waits exactly that long, bounded by maxRetries=3 + retryCeilingMs=20000. The per-tool-timeout gap stands — no `AbortSignal.timeout` composed onto `transport.callTool` yet. |
| 03 | idempotency-deduplication-and-delivery-semantics | All MCP tool calls are reads (idempotent by accident). The 60s TTL cache is the only dedup. Writes back to Bloomreach: NOT YET EXERCISED. |
| 04 | consistency-models-and-staleness | Read-your-writes solved by the client carrying state across requests. Cross-instance: no consistency model at all. 60s TTL on the one distributed adapter; the in-process synthetic adapter is always "fresh" but that's cosmetic — its data is static. |
| 05 | replication-partitioning-and-quorums | NOT YET EXERCISED. There's nothing replicated to coordinate. Vercel is multi-instance but the app pretends it isn't. |
| 06 | queues-streams-ordering-and-backpressure | NDJSON streams from server → client (one-way, ordered by emission). No work queues, no backpressure beyond `ReadableStream`'s built-in. |
| 07 | clocks-coordination-and-leadership | NOT YET EXERCISED. `Date.now()` is used for cache TTLs and rate-limit spacing — all within one process, so no clock-skew problems. |
| 08 | sagas-outbox-and-cross-boundary-workflows | The two-step investigation IS a cross-boundary workflow with handoff state — but the "saga" is the user clicking "next step" with sessionStorage as the outbox. |
| 09 | distributed-systems-red-flags-audit | Top 3: cross-instance state loss, no per-tool timeout on the Bloomreach adapter, no idempotency story for any future write. |
| 10 | transport-agnostic-protocol-design | RETIRED. Authored when there were two distributed transports (HTTP+SSE Bloomreach and stdio Olist); the Olist adapter was deleted in PR #8. The DataSource seam still demonstrates the adapter pattern, but only one transport actually crosses a process boundary now. Kept as a historical record. |

---

## Where this sits vs neighbors

- **`study-system-design/`** — owns architecture, scale, storage choice. It names the same in-memory-state risk; this guide explains *why* it's a distributed-systems problem (cross-instance coordination gap), not just a storage one.
- **`study-database-systems/`** — owns datastore-local consistency. Doesn't apply here (no database).
- **`study-networking/`** — owns DNS/TLS/HTTP semantics. The retry-on-429 here uses HTTP semantics that file walks.
- **`study-runtime-systems/`** — owns the event loop inside one Vercel instance. The "stateful server" failure mode lives at the boundary between *that* file (one instance) and *this* file (many instances).

Cross-link rather than re-teach.
