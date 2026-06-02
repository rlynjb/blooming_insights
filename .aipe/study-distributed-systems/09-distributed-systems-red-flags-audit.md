# 09 — distributed-systems red flags (ranked)

**Industry name(s):** risk register · failure-mode audit · partial-failure inventory
**Type:** Audit — opinionated, ranked

> **Verdict-first:** the three load-bearing distributed-systems risks in this codebase, in order of how soon they bite: **(1) cross-instance state silently missing** when Vercel routes a request to a different instance than the one that holds the in-memory `Map` (the same finding `study-system-design/` ranks as its #1 CRITICAL); **(2) no per-tool timeout on MCP calls** — a hung Bloomreach connection consumes the route's whole 300s budget with no upstream signal; **(3) no idempotency story for any future write** — the moment the recommendation agent gets an "execute" button, the absence of an idempotency key per click becomes a data-corruption bug. Everything else (no retry on Anthropic, no per-tool TTL tuning, sessionStorage tab-only handoff, no resume-on-disconnect for NDJSON streams) is real but ranks below these three.

---

## Zoom out, then zoom in

```
  Zoom out — the risk surface

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  RISK 7: NDJSON disconnect = lost events (low impact)     │
  │  RISK 5: sessionStorage tab-only handoff                  │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼────────────────────────────────┐
  │  ★ RISK 1: cross-instance state loss (CRITICAL) ★         │ ← top risk
  │  ★ RISK 2: no per-tool timeout (HIGH) ★                   │
  │  ★ RISK 3: no idempotency for future writes (HIGH) ★      │
  │  RISK 4: no retry on Anthropic transport errors           │
  │  RISK 6: no per-tool TTL tuning                           │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼────────────────────────────────┐
  │  RISK 8: Bloomreach's own failures (their problem,        │
  │          our retry handles)                               │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** This file ranks every distributed-systems risk in the codebase by *how soon does this actually hurt a user, and how badly when it does?* Severity bands: **CRITICAL** (will silently corrupt or lose data), **HIGH** (will degrade UX or burn budget under predictable conditions), **MEDIUM** (will cause failures only under stress or after specific feature additions), **LOW** (real but bounded; named for honesty, not action).

---

## Structure pass

**Layers.** Same three the rest of the guide uses — UI, Service, Provider.

**Axis: blast radius.** Hold one question across the risks: *when this fires, how many users are affected and what do they observe?* The top two are service-layer issues that affect every user under specific conditions (cross-instance route, hung MCP call). The middle risks are conditional on features that don't exist yet. The bottom risks are bounded — bad UX moments, not data corruption.

**Seams.** None — this file is an audit, not a mechanism walkthrough.

---

## The ranked findings

### RISK 1 — cross-instance state silently missing (CRITICAL)

**Where:** `lib/state/insights.ts:4-6`, `lib/state/investigations.ts:11`, `lib/mcp/schema.ts:131`
**Cross-link:** `study-system-design/audit.md#system-design-red-flags-audit` ranks this #1 with the same evidence.

**The failure:** In production on Vercel, two requests for the same user can land on two different process instances. Each instance has its own `Map<string, Insight>` and its own `cached: WorkspaceSchema | null`. When a request for `/api/agent?insightId=X` lands on an instance whose Map doesn't have X, the lookup returns null. The route falls back to `resolveAnomaly` (`app/api/agent/route.ts:37-62`), which tries in-memory first (miss), then the `?insight=` query param (if the client sent it), then the demo snapshot. For live runs without the query param, the result is a 404.

**Why it's CRITICAL:** It's silent — no error fires, no observability flags it. The user sees a 404 or an empty feed and assumes "the system isn't working" rather than "the state landed on a different instance." This is the bug that breaks first under any concurrent load.

**Evidence of the gap:**
```
  lib/state/insights.ts:4-6
  const insights = new Map<string, Insight>();    ← per-process; no cross-instance link
  const investigations = new Map<string, Investigation>();
  const anomalies = new Map<string, Anomaly>();
```

**Mitigation present:** The client carries the insight via `?insight=<json>` query param in live mode (`lib/hooks/useInvestigation.ts:160-161`). This works as a backstop *for the agent route* but not for the briefing route, and not for any route that doesn't accept the data via query.

**Right next move:** Vercel KV (or any cross-instance store) keyed by `bi_session + insightId`. ~50 lines of code to swap the `Map` for a KV-backed reader. The "no database" architectural choice is deliberate (file 05 of `study-system-design/`) but it's also the single biggest distributed-systems risk in the codebase.

---

### RISK 2 — no per-tool timeout on MCP transport (HIGH)

**Where:** `lib/mcp/client.ts:148-163`, `lib/mcp/transport.ts:47-59`

**The failure:** `McpClient.liveCall` awaits `transport.callTool(name, args)` directly with no timeout wrapper. If Bloomreach's MCP server accepts the TCP connection but then hangs (no response, no FIN), the await hangs. The only ceiling is the route's `maxDuration = 300` (`app/api/agent/route.ts:20`). A single hung MCP call burns the whole 5-minute budget; from the user's perspective, the briefing or investigation appears stuck for 5 minutes then errors out (or, in production, gets killed with no observable error if Vercel's process kill doesn't propagate to a clean stream close).

**Why it's HIGH and not CRITICAL:** Bloomreach almost certainly has its own server-side timeouts, so in practice the hang would resolve within seconds — but you have no contract on this from your side. A hang under Bloomreach incident conditions IS plausible and would burn budget for every concurrent user.

**Right next move:** Wrap `transport.callTool` in a `Promise.race` against a 30s timer; throw `McpToolError` with a "tool timeout" detail on timeout. ~10 lines.

**Why it's not done:** Same reason as much of the codebase's distributed-systems hardening — hackathon scale hasn't exercised it. A single incident's worth of "the demo froze for 5 minutes" would justify the 10 lines.

---

### RISK 3 — no idempotency story for any future write (HIGH, conditional)

**Where:** `lib/agents/recommendation.ts`, `lib/agents/diagnostic.ts`, `lib/mcp/client.ts` — all currently read-only

**The failure:** Currently the codebase only calls read tools (`list_*`, `get_*`, `execute_analytics_eql`). Every retry is safe because rereading data has no effect. The moment a write tool is added — `create_voucher`, `start_campaign`, `update_segmentation` — the absence of idempotency means a retried write creates a duplicate. The `McpClient.callTool` retry loop (file 02) would happily retry a 429 on a write, potentially creating two vouchers from one user click.

**Why it's HIGH and conditional:** The failure cannot fire today (no writes). The day a write is added, it fires immediately. That makes this a "ready to bite the moment a feature ships" risk — worth tracking even though it's currently inert.

**Right next move when the day comes:** Add an `idempotencyKey?: string` to `CallToolOptions` (`lib/mcp/client.ts:3`); when present, include it in the args under a known key (e.g. `_idem`); maintain a `Map<idempotencyKey, result>` separate from the TTL cache, with a much longer retention. Server-side support depends on Bloomreach honoring an idempotency key in the request — verify before relying on it.

**Reminder anchor:** the comment block in `lib/agents/recommendation.ts` (the prompt template) explicitly limits the agent to *describing* actions, not executing them. That comment IS the distributed-systems control that keeps this risk inert.

---

### RISK 4 — no retry on Anthropic transport errors (MEDIUM)

**Where:** `lib/agents/base.ts:102` (`anthropic.messages.create(params)`)

**The failure:** The Anthropic SDK call has no retry wrapper in this code. If Anthropic returns a 5xx, a 429, or a network error, it propagates as an exception that the route catches and emits as `{ type: 'error' }`. The user sees an error and has to manually retry by reloading. **Inferred:** the Anthropic SDK may retry internally; the codebase does not configure or override.

**Why it's MEDIUM:** Anthropic's published reliability is high; transient failures are rare. The user-driven retry (reload the page) absorbs the rare event. But under an Anthropic incident, *every* request fails immediately with no app-side resilience.

**Right next move:** A thin retry wrapper around `anthropic.messages.create` — at most 2 retries with 1s + 5s backoff on 5xx and 429. Per-call; no need for a shared client like `McpClient`. ~15 lines.

---

### RISK 5 — sessionStorage handoff is tab-only (MEDIUM)

**Where:** `lib/hooks/useInvestigation.ts:18-19, 137-140`

**The failure:** The diagnosis handoff between step 2 and step 3 lives in `sessionStorage.bi:diag:<id>`. sessionStorage is per-tab; closing the tab loses it. A user who runs step 2, closes the laptop, and reopens the step 3 URL tomorrow gets "no diagnosis was handed over" (`app/api/agent/route.ts:228-230`).

**Why it's MEDIUM:** UX papercut, not data corruption. The user navigates back to step 2, which re-runs (live) or replays (from cache), then forward to step 3. Recoverable, but bad first impression.

**Right next move:** Persist the diagnosis server-side keyed by `insightId` in Vercel KV. This change ALSO partially mitigates RISK 1 (server-side cross-instance store). Couple the two improvements.

---

### RISK 6 — fixed 60s TTL across all tools (LOW)

**Where:** `lib/mcp/client.ts:103`

**The failure:** Every tool gets the same 60s cache TTL. `list_funnels` (schema-shaped, slow to change) and `execute_analytics_eql` (data-shaped, real-time) get the same staleness budget. The infrastructure to vary TTL exists (`CallToolOptions.cacheTtlMs`) but no callsite uses it.

**Why it's LOW:** Current workload doesn't exercise the difference. Real-time-sensitive features would force a per-tool TTL story; nothing today is real-time-sensitive.

**Right next move:** Wire `cacheTtlMs` at each callsite based on tool semantics — schema tools at hours, analytics tools at minutes, summary tools at 60s. Trivial change once the workload demands it.

---

### RISK 7 — no resume-on-disconnect for NDJSON streams (LOW)

**Where:** `app/api/agent/route.ts:131-141, 169-264`, `lib/hooks/useInvestigation.ts:184-208`

**The failure:** If the client disconnects mid-stream (closes tab, loses network), the server writes fail silently and the stream closes. The client cannot reconnect and resume; it can only re-fetch from the start. For the demo/cached path this is fine (instant restart). For a live agent run that's already burned 60s of MCP calls, this means re-burning them on retry.

**Why it's LOW:** Mid-stream disconnect is rare. The route's `try/catch/finally` ensures clean closure on the server side. The cached-replay path absorbs most retries without re-running the agent.

**Right next move:** Switch to Server-Sent Events with `Last-Event-ID` and a server-side per-stream cursor. The `collected: AgentEvent[]` (line 171 of `app/api/agent/route.ts`) is already shaped right — replay from index N. Lift IF a workload arises where mid-stream disconnect is common.

---

### RISK 8 — Bloomreach's own failures (LOW, external)

**Where:** External — not our code.

**The failure:** Bloomreach's MCP server goes down, slow, or starts returning unexpected error shapes. Our `McpClient` retry handles 429s; non-429 transport errors throw immediately and surface to the user as a stream error.

**Why it's LOW from a "what can we do" perspective:** This is the external dependency every system has. Our partial-failure handling (file 02) is the right shape for it; bigger investments (circuit breaker, fallback model, multi-provider failover) are scale features.

**Right next move:** A simple circuit breaker — open after 5 consecutive non-429 failures in 30 seconds; close after a 30-second cooldown probe. Spares the user 6 sequential 30s retry attempts during an incident. ~30 lines.

---

## Primary diagram

```
  Distributed-systems risks — ranked by blast radius and inevitability

  ┌─ when does it fire? ──────────────────┬─ blast radius ──┐
  │                                         │                 │
  │ RIGHT NOW under any concurrent load:    │                 │
  │  ★ RISK 1: cross-instance state loss   │ all users       │
  │    silent; 404s or empty feeds          │ silent failure  │
  │                                         │                 │
  │ UNDER ANY HANG / INCIDENT:              │                 │
  │  ★ RISK 2: no MCP call timeout         │ one request     │
  │    burns 300s budget                    │ visible freeze  │
  │  RISK 4: no Anthropic retry             │ one request     │
  │  RISK 8: Bloomreach incident            │ all users       │
  │                                         │                 │
  │ THE DAY A WRITE FEATURE SHIPS:          │                 │
  │  ★ RISK 3: no idempotency              │ data corruption │
  │                                         │ duplicate writes│
  │                                         │                 │
  │ UNDER TAB-CLOSE EDGE CASES:             │                 │
  │  RISK 5: sessionStorage tab-only        │ one user        │
  │  RISK 7: no NDJSON resume               │ one user        │
  │                                         │                 │
  │ NEVER FOR THIS WORKLOAD:                │                 │
  │  RISK 6: fixed 60s TTL                  │ none today      │
  │                                         │                 │
  └─────────────────────────────────────────┴─────────────────┘

  the top 3 are the ones worth fixing first; everything below is
  honest about the bound on impact
```

---

## Implementation in codebase

| Risk | File | Line(s) | What to look at |
|------|------|---------|-----------------|
| 1 (CRITICAL) | `lib/state/insights.ts` | 4-6 | per-process Map; no cross-instance link |
| 1 | `lib/state/investigations.ts` | 11, 22-41 | mem-first fallback chain; misses on cold instance |
| 1 | `app/api/agent/route.ts` | 37-62 | `resolveAnomaly` — the fallback chain that silently misses |
| 2 (HIGH) | `lib/mcp/client.ts` | 148-163 | `liveCall` — no Promise.race against a timer |
| 2 | `app/api/agent/route.ts` | 20 | `maxDuration = 300` — the only ceiling |
| 3 (HIGH cond.) | `lib/mcp/client.ts` | 3 | `CallToolOptions` has no idempotency key field |
| 3 | `lib/agents/base.ts` | 144-156 | tool-call dispatch — no per-call idempotency |
| 4 (MED) | `lib/agents/base.ts` | 102 | `anthropic.messages.create` — no retry wrapper |
| 5 (MED) | `lib/hooks/useInvestigation.ts` | 18-19, 137-140 | sessionStorage handoff — tab-only |
| 5 | `app/api/agent/route.ts` | 228-230 | the "no diagnosis was handed over" throw |
| 6 (LOW) | `lib/mcp/client.ts` | 103 | `ttl = options.cacheTtlMs ?? 60_000` — no callsite overrides |
| 7 (LOW) | `app/api/agent/route.ts` | 169-264 | stream has no event ID or resume |
| 7 | `lib/hooks/useInvestigation.ts` | 184-208 | consumer has no Last-Event-ID logic |
| 8 (LOW ext.) | external | — | no circuit breaker on `McpClient` for non-429 |

---

## The first three fixes (recommended priority)

If you had a week:

1. **Vercel KV-backed state store.** Swap `lib/state/insights.ts`'s `Map` and `lib/state/investigations.ts`'s `mem` for KV reads/writes keyed by `bi_session + id`. Fixes RISK 1 outright and partially fixes RISK 5 (diagnosis handoff can also live in KV). Probably 100-150 lines of code with tests.

2. **Per-tool timeout in `McpClient`.** Wrap `liveCall`'s `transport.callTool` await in a `Promise.race` against a 30s timer (configurable per-call via `CallToolOptions`). Throw `McpToolError` with timeout detail. Fixes RISK 2. ~15 lines.

3. **Anthropic retry wrapper.** Wrap `anthropic.messages.create` in `lib/agents/base.ts` with up to 2 retries on 5xx and 429 with 1s + 5s backoff. Fixes RISK 4. ~20 lines.

After these three, the codebase's distributed-systems posture goes from "honestly named hackathon-scale" to "production-aware single-tenant." The remaining work (idempotency for writes, circuit breaker, SSE with resume) becomes feature-driven rather than infrastructure-driven.

---

## Interview defense

**Q: What's the biggest distributed-systems risk in this codebase?**

In-memory state on Vercel. Every piece of state — insights, investigations, the cached schema — lives in process-local `Map`s and module-level variables. Vercel scales horizontally and recycles instances; nothing in the code coordinates across instances. The failure is silent: a request landing on a fresh instance just sees an empty Map. There's a partial workaround (the client carries the insight in a query param for live mode) but no general solution. Fix is Vercel KV, keyed by session + id; ~150 lines including tests.

```
  RISK 1: cross-instance state loss

  inst A: Map{X: Insight}   inst B: Map{}
                              │
  user request lands on inst B → null → 404 (silently)
  
  fix: replace Map with Vercel KV reads
```

**Q: What's the highest-leverage second fix?**

A per-tool timeout on MCP calls. Today a hung Bloomreach connection burns the route's whole 300s budget — five minutes of visible freeze with no upstream signal. Wrap `transport.callTool` in `Promise.race` against a 30-second timer; throw a tagged error on timeout. Maybe 15 lines. Closes the "hung connection" failure mode without restructuring anything.

**Q: What's the latent risk you'd flag for a code reviewer?**

The day someone adds a write tool — `create_voucher`, `start_campaign`, anything that mutates Bloomreach state — the existing retry loop will happily retry a 429 and potentially create duplicate writes. No idempotency key is sent today because no write is being made. The recommendation agent only *describes* actions; the moment that becomes execute, you need idempotency keys per click plus server-side dedup. The architectural control today is the prompt saying "describe, don't execute" — that's the only thing preventing the bug.

---

## See also

- `01-distributed-system-map.md` — the map that puts these risks in spatial context
- `02-partial-failure-timeouts-and-retries.md` — RISK 2 in mechanism depth
- `03-idempotency-deduplication-and-delivery-semantics.md` — RISK 3 in mechanism depth
- `04-consistency-models-and-staleness.md` — RISK 5 in mechanism depth
- `05-replication-partitioning-and-quorums.md` — RISK 1's structural cause
- `.aipe/study-system-design/audit.md#system-design-red-flags-audit` — the system-design twin of this audit
- `.aipe/study-security/` — security-shaped risks at the same boundaries
