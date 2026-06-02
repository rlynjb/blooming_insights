# Overview — distributed systems in blooming insights

**Industry name(s):** coordination boundaries · partial-failure surface · stateless-server / stateful-client
**Type:** Industry standard · Language-agnostic

> blooming insights is a **single-process Next.js app on Vercel** — no replicas you coordinate, no workers, no queues, no consensus, no leader election, no shared mutable cluster state. **What IS distributed is the boundary work**: every meaningful piece of the system crosses a network into a partner that can be slow, rate-limited, or unreachable. The Bloomreach MCP server enforces a global ~1 req/s/user limit, the Anthropic API can latency-spike or 429 you, the Bloomreach IdP holds tokens, and Vercel can recycle the instance holding your in-memory state at any moment. So the distributed-systems lens here is narrow but real: **partial failure at every external hop**, **stateless server / stateful client coordination** for investigation handoffs, and **the inability to coordinate across Vercel instance recycles**. The most consequential mechanism is `McpClient`'s parse-the-server's-own-retry-window retry; the most consequential gap is that nothing in this app coordinates across instances.

---

## Zoom out — distributed surface

```
  blooming insights — distributed surface (what crosses a network)

  ┌─ Client (browser) ───────────────────────────────────────────────────────┐
  │  React + sessionStorage  (bi:diag:<id>  bi:insight:<id>  bi:inv:*)       │
  │  ★ CARRIES STATE THE SERVER CANNOT REMEMBER ACROSS INSTANCES ★            │
  └─────────────────────────────┬────────────────────────────────────────────┘
                                │  HTTPS · cookies (bi_session + bi_auth)
                                ▼
  ┌─ Vercel instance N (Next route handler · maxDuration 300s) ──────────────┐
  │  in-memory Map (insights, investigations)  ◄── DOES NOT survive recycle  │
  │  module-cached schema (per-process)        ◄── DOES NOT survive recycle  │
  └─────┬────────────────────┬───────────────────────────────┬───────────────┘
        │                    │                               │
        │ HTTPS + Bearer     │ HTTPS                         │ HTTPS
        ▼                    ▼                               ▼
  ┌─ Bloomreach MCP ─┐  ┌─ Anthropic API ─┐         ┌─ Bloomreach IdP ─┐
  │  ~1 req/s/user   │  │  rate limits +   │         │  OAuth + DCR +    │
  │  GLOBAL          │  │  variable        │         │  PKCE             │
  │  partial failure │  │  latency         │         │  partial failure  │
  │  is the norm     │  │  partial failure │         │  drops verifier   │
  └──────────────────┘  └──────────────────┘         └──────────────────┘
```

The interesting boxes are the three external providers and the dashed gap above the route handler. Everything inside one Vercel invocation is single-process; everything that crosses a layer in that diagram is distributed.

**Zoom in — what this guide covers.** Three things actually apply at the distributed-systems lens. (1) **Partial failure at external boundaries** — `McpClient`'s retry-with-parsed-window is genuine partial-failure engineering and lives in `lib/mcp/client.ts:121-132`. (2) **Stateless server, stateful client** — the diagnosis handoff between investigation steps is carried by the *browser* through `sessionStorage`, not by the server, precisely because Vercel might route step 3 to a different instance than step 2 (`lib/hooks/useInvestigation.ts:18-19`). (3) **No cross-instance coordination** — the in-memory `Map` in `lib/state/insights.ts:4-6` is per-process; nothing in the app reconciles two instances seeing different state. Everything else on the canonical distributed-systems checklist (consensus, replication, leader election, partition tolerance, quorum) is **not yet exercised** — and labelled as such where it matters.

---

## Structure pass

**Layers.** Four, ordered by how much coordination they require: **client** (one browser, no peers) → **Vercel instance** (one Node process, no peers it knows about) → **external boundary** (HTTPS hop to MCP/Anthropic/IdP) → **external system** (their own distributed internals, opaque to us). The interesting work is at the third layer: the boundary. Everything inside the first two layers is single-process; everything past the fourth is someone else's problem.

**Axis: guarantees.** Hold one question across every layer: *what does this layer promise the layer above it, and what happens when it can't keep the promise?* The client promises "I'll re-render when state changes" — strong, local. The Vercel instance promises "if I'm alive, my `Map` has what you stored" — and the silent failure is when the instance dies between requests. The external-boundary layer (your `McpClient`) promises "I'll retry rate-limit errors within a budget, then surface them" — a *bounded* promise, which is the right kind for partial failure. The external system promises only what its 429 envelope says: "retry after N seconds." Guarantees weaken as you descend, and the right response is for the upper layer to know what the lower one *can't* promise.

**Seams.** Three load-bearing, one fake.

- **Seam A: client ↔ server** (browser ↔ Vercel instance). The guarantee flips from "session-local React state" to "request-local instance memory." `sessionStorage` survives this seam in both directions; in-memory `Map`s in the server do not survive *between* this seam crossings if Vercel routes you to a new instance. This is why `bi:diag:<id>` exists.
- **Seam B: route ↔ McpClient** (cosmetic — same process, same await chain). No guarantee flip. Listed here only so it's not mistaken for a distributed seam.
- **Seam C: McpClient ↔ Bloomreach MCP** (HTTPS, rate-limited). Guarantee flips from "I'll space and retry for you" to "global ~1 req/s window, may 429 anyway." This is the load-bearing distributed seam — every retry, timeout, idempotency question lives here.
- **Seam D: connect-request ↔ callback-request** (same OAuth flow, possibly different Vercel instances). Guarantee flips from "PKCE verifier saved in memory at connect-time" to "PKCE verifier must be readable at callback-time, possibly on a different instance." Solved by the encrypted `bi_auth` cookie (`lib/mcp/auth.ts:38-104`).

```
  Structure pass — guarantees down the stack

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
                           │  seam C — boundary into MCP
                           ▼
  ┌─ McpClient (in-process broker) ───────────────────────┐
  │  guarantee: cache + space + retry-with-parsed-window   │
  │  breaks when: budget spent (maxRetries=3) or non-429   │
  │               transport error (no retry on those)      │
  └────────────────────────┬──────────────────────────────┘
                           │  HTTPS
                           ▼
  ┌─ external system (Bloomreach MCP) ────────────────────┐
  │  guarantee: ~1 req/s/user GLOBAL, stated in 429 text   │
  │  breaks: their problem, but it lands on you            │
  └───────────────────────────────────────────────────────┘
```

Seam C is the seam to study. Seam D is the second one. Seam A matters because Vercel can't fix it for you — the client carries the state.

---

## How distributed systems shows up here

```
  Three things that genuinely apply at the distributed-systems lens

  1. PARTIAL FAILURE AT EXTERNAL BOUNDARIES
     McpClient: cache + spacing + parse-the-server's-own-retry-window
     → file 02 (timeouts + retries), file 03 (idempotency)

  2. STATELESS SERVER, STATEFUL CLIENT
     useInvestigation hands the diagnosis from step 2 → step 3 via
     sessionStorage because the server cannot remember it
     → file 04 (consistency + staleness)

  3. NO CROSS-INSTANCE COORDINATION
     in-memory Map in lib/state/insights.ts is per-process;
     two concurrent users on two Vercel instances see different state
     → file 05 (replication — explicitly NOT YET EXERCISED),
       file 09 (red-flags audit)
```

Everything else on the standard distributed-systems checklist — consensus, leader election, multi-region replication, quorums, sagas, stream ordering, vector clocks, split-brain — does not apply here. The files below say so plainly where they don't, and walk the mechanism only where it does.

---

## Reading order

| # | File | Verdict |
|---|------|---------|
| 01 | distributed-system-map | The map: client, Vercel instance, MCP, Anthropic, IdP. Three real boundaries, two ownership flips. |
| 02 | partial-failure-timeouts-and-retries | The load-bearing one: McpClient parses Bloomreach's "Retry after N seconds" and waits exactly that long, bounded by maxRetries=3 + retryCeilingMs=20000. |
| 03 | idempotency-deduplication-and-delivery-semantics | All MCP tool calls are reads (idempotent by accident). The 60s TTL cache is the only dedup. Writes back to Bloomreach: NOT YET EXERCISED. |
| 04 | consistency-models-and-staleness | Read-your-writes solved by the client carrying state across requests. Cross-instance: no consistency model at all. |
| 05 | replication-partitioning-and-quorums | NOT YET EXERCISED. There's nothing replicated to coordinate. Vercel is multi-instance but the app pretends it isn't. |
| 06 | queues-streams-ordering-and-backpressure | NDJSON streams from server → client (one-way, ordered by emission). No work queues, no backpressure beyond `ReadableStream`'s built-in. |
| 07 | clocks-coordination-and-leadership | NOT YET EXERCISED. `Date.now()` is used for cache TTLs and rate-limit spacing — all within one process, so no clock-skew problems. |
| 08 | sagas-outbox-and-cross-boundary-workflows | The two-step investigation IS a cross-boundary workflow with handoff state — but the "saga" is the user clicking "next step" with sessionStorage as the outbox. |
| 09 | distributed-systems-red-flags-audit | Top 3: cross-instance state loss, no idempotency story for any future write, no per-tool timeout (only the 300s route ceiling and the rate-limit retry ceiling). |

---

## Where this sits vs neighbors

- **`study-system-design/`** — owns architecture, scale, storage choice. It names the same in-memory-state risk; this guide explains *why* it's a distributed-systems problem (cross-instance coordination gap), not just a storage one.
- **`study-database-systems/`** — owns datastore-local consistency. Doesn't apply here (no database).
- **`study-networking/`** — owns DNS/TLS/HTTP semantics. The retry-on-429 here uses HTTP semantics that file walks.
- **`study-runtime-systems/`** — owns the event loop inside one Vercel instance. The "stateful server" failure mode lives at the boundary between *that* file (one instance) and *this* file (many instances).

Cross-link rather than re-teach.

---

Updated: 2026-06-01 — Initial generation as v1.55 distributed-systems guide (Partially Case B). Single-process app; boundaries to external services + cross-instance coordination gap are the real distributed-systems surface. Consensus / replication / leader-election explicitly NOT YET EXERCISED.
