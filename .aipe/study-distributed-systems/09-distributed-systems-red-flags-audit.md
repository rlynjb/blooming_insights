# 09 — distributed-systems red flags (ranked)

**Industry name(s):** risk register · failure-mode audit · partial-failure inventory
**Type:** Audit — opinionated, ranked

> **Verdict-first:** the four load-bearing distributed-systems risks in this codebase, in order of how soon they bite: **(1) cross-instance state silently missing** when Vercel routes a request to a different instance than the one that holds the in-memory `Map` (the same finding `study-system-design/` ranks as its #1 CRITICAL); **(2) no per-tool timeout on the Bloomreach adapter** — a hung Bloomreach connection consumes the route's whole 300s budget with no upstream signal (the Olist adapter has the per-call 30s `AbortSignal.timeout` already, so this gap is now *adapter-asymmetric*); **(3) no idempotency story for any future write** — the moment the recommendation agent gets an "execute" button, the absence of an idempotency key per click becomes a data-corruption bug; **(4) subprocess lifecycle hazards on the Olist adapter** — `dispose()` is best-effort, no respawn on child crash, and a forgotten dispose leaks a child process. Everything else (no retry on Anthropic, no per-tool TTL tuning, sessionStorage tab-only handoff, no resume-on-disconnect for NDJSON streams, the K=10 parallel-eval race that already bit us) is real but ranks below these four.

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
  │  ★ RISK 2: no per-tool timeout on BLOOMREACH adapter      │
  │    (HIGH) — Olist side is fixed; gap is asymmetric ★      │
  │  ★ RISK 3: no idempotency for future writes (HIGH) ★      │
  │  ★ RISK 10: subprocess lifecycle hazards on Olist (MED) ★ │
  │  RISK 4: no retry on Anthropic transport errors           │
  │  RISK 6: no per-tool TTL tuning                           │
  │  RISK 9: parallel-eval race (LOW — already mitigated by   │
  │          EVAL_RUN_TAG)                                    │
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

### RISK 2 — no per-tool timeout on the BLOOMREACH adapter (HIGH; adapter-asymmetric)

**Where:** `lib/data-source/bloomreach-data-source.ts:190-205`, `lib/mcp/transport.ts:47-59`

**The failure:** `BloomreachDataSource.liveCall` awaits `transport.callTool(name, args, { signal })` with only the route-level cancellation signal (not a per-call timer). If Bloomreach's MCP server accepts the TCP connection but then hangs (no response, no FIN), the await hangs. The only ceiling is the route's `maxDuration = 300` (`app/api/agent/route.ts:20`). A single hung MCP call burns the whole 5-minute budget; from the user's perspective, the briefing or investigation appears stuck for 5 minutes then errors out (or, in production, gets killed with no observable error if Vercel's process kill doesn't propagate to a clean stream close).

**The asymmetry worth naming:** `OlistDataSource` does *not* have this gap — it composes `AbortSignal.timeout(30_000)` onto every call (`lib/data-source/olist-data-source.ts:151`). So the partial-failure posture is now **per-adapter**: the Olist side has a per-call deadline, the Bloomreach side does not. The right fix for RISK 2 is to lift the same `AbortSignal.timeout` pattern into `BloomreachDataSource.liveCall` — the building block is already used in the codebase.

**Why it's HIGH and not CRITICAL:** Bloomreach almost certainly has its own server-side timeouts, so in practice the hang would resolve within seconds — but you have no contract on this from your side. A hang under Bloomreach incident conditions IS plausible and would burn budget for every concurrent user.

**Right next move:** Mirror the Olist pattern. Compose `AbortSignal.timeout(30_000)` with the existing `options.signal` in `liveCall`; throw `McpToolError` with a "tool timeout" detail on timeout. ~10 lines.

**Why it's not done:** Same reason as much of the codebase's distributed-systems hardening — hackathon scale hasn't exercised it. A single incident's worth of "the demo froze for 5 minutes" would justify the 10 lines.

---

### RISK 3 — no idempotency story for any future write (HIGH, conditional)

**Where:** `lib/agents/recommendation.ts`, `lib/agents/diagnostic.ts`, `lib/data-source/bloomreach-data-source.ts`, `lib/data-source/olist-data-source.ts` — all currently read-only

**The failure:** Currently the codebase only calls read tools (`list_*`, `get_*`, `execute_analytics_eql` on Bloomreach; `get_metric_timeseries`, `get_segments`, `get_anomaly_context` on Olist). Every retry is safe because rereading data has no effect. The moment a write tool is added — `create_voucher`, `start_campaign`, `update_segmentation` — the absence of idempotency means a retried write creates a duplicate. The `BloomreachDataSource.callTool` retry loop (file 02) would happily retry a 429 on a write, potentially creating two vouchers from one user click.

**Why it's HIGH and conditional:** The failure cannot fire today (no writes). The day a write is added, it fires immediately. That makes this a "ready to bite the moment a feature ships" risk — worth tracking even though it's currently inert.

**Right next move when the day comes:** Add an `idempotencyKey?: string` to `DataSourceCallOptions` (`lib/data-source/types.ts:38`); when present, include it in the args under a known key (e.g. `_idem`); maintain a `Map<idempotencyKey, result>` separate from the TTL cache, with a much longer retention. Server-side support depends on Bloomreach (or any future write-capable backend) honoring an idempotency key in the request — verify before relying on it.

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

**The failure:** Bloomreach's MCP server goes down, slow, or starts returning unexpected error shapes. Our `BloomreachDataSource` retry handles 429s; non-429 transport errors throw immediately and surface to the user as a stream error.

**Why it's LOW from a "what can we do" perspective:** This is the external dependency every system has. Our partial-failure handling (file 02) is the right shape for it; bigger investments (circuit breaker, fallback model, multi-provider failover) are scale features.

**Right next move:** A simple circuit breaker — open after 5 consecutive non-429 failures in 30 seconds; close after a 30-second cooldown probe. Spares the user 6 sequential 30s retry attempts during an incident. ~30 lines.

---

### RISK 9 — parallel-eval race (LOW; already mitigated)

**Where:** `eval/scripts/run-detection.ts:87-100`, `run-diagnosis.ts:118-127`, `run-recommendation.ts:136-145`, `run-regression.ts:178-187`

**The failure:** Two eval scripts running in parallel on the same day write into the same date-stamped results directory (`eval/results/<YYYY-MM-DD>/`), clobbering each other's per-run JSON and `summary.md`. This bit the team for real once: the main session ran K=10 from Bash while a sub-agent ALSO ran K=10 in parallel. Detected via `ps aux`; the rogue PIDs were killed before they finished overwriting each other.

**Why it's LOW:** The mitigation is in place. Every eval script honors `process.env.EVAL_RUN_TAG`; setting `EVAL_RUN_TAG=after-fix npm run eval:detection` lands results in `eval/results/2026-06-15-after-fix/`. Two parallel runs with different tags don't collide.

**Why it's still worth listing:** (a) The fix is convention, not enforcement — if a future eval script doesn't honor `EVAL_RUN_TAG`, the race re-appears silently. (b) The lesson — namespace separation as a coordination primitive — generalises beyond the eval scripts to any future cross-instance scenario in the Vercel app (file 05, Part 6).

**Right next move (if scale demanded it):** Promote the `makeResultsDir()` shape into a shared helper so all eval scripts share the same `EVAL_RUN_TAG`-honoring logic; document the convention in the eval README. Add a CI check that any new `mkdirSync` under `eval/` uses the helper. None of these are urgent.

---

### RISK 10 — subprocess lifecycle hazards on the Olist adapter (MEDIUM, new in Phase 2)

**Where:** `lib/data-source/olist-data-source.ts:93-197`, `lib/data-source/index.ts:73-109`

**The failure:** `OlistDataSource` owns a child process. Three hazards live in that ownership:

- **Forgotten dispose leaks a child.** Routes that construct an `OlistDataSource` via `makeDataSource('live-sql', sid)` get a `dispose: () => Promise<void>` in the result envelope. If the route forgets the `finally` block, the subprocess outlives the request. On Vercel this is bounded (instance recycling reaps orphans), but the route ought to clean up explicitly. The briefing route does (`app/api/briefing/route.ts:312` calls `disposeDataSource()` in finally); a future route that copies the construct-but-not-dispose pattern would leak.
- **No respawn on child crash.** If the child process crashes mid-call, the adapter surfaces `OlistToolError` but does not restart. The `client` and `transport` fields remain set; the next `connect()` short-circuits because `this.client` is truthy. The user retries by issuing a fresh `callTool`, which dispatches into a half-dead client. No automatic recovery.
- **Best-effort dispose swallows errors.** Both `client.close()` and `transport.close()` are wrapped in `try { } catch { /* best-effort */ }` (`olist-data-source.ts:182-195`). A dispose that fails (zombie child, EPIPE) leaves no observability trail. Currently fine; under any future "we want to know when subprocess teardowns fail" requirement, this is the gap.

**Why it's MEDIUM:** All three hazards are real but bounded. Leak: bounded by Vercel recycling. No respawn: the user-driven retry resets the route, which constructs a fresh `OlistDataSource`. Silent dispose: cosmetic for now.

**Right next move:**
1. Add a respawn-on-crash path: detect `EPIPE` / closed transport in `callTool` and reset the adapter state to allow a fresh `connect()`.
2. Log dispose errors to a single line on stderr (not throw — best-effort is right, but observable best-effort is better).
3. Document the dispose contract in the `DataSource` interface so any future adapter inherits the discipline.

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
  │  ★ RISK 2: no Bloomreach call timeout  │ one request     │
  │    burns 300s budget (Olist side ok)    │ visible freeze  │
  │  RISK 4: no Anthropic retry             │ one request     │
  │  RISK 8: Bloomreach incident            │ all users       │
  │                                         │                 │
  │ ON A LIVE-SQL ROUTE THAT FORGETS:       │                 │
  │  ★ RISK 10: subprocess lifecycle       │ leaked child    │
  │    (leak, no respawn, silent dispose)   │ + opaque fails  │
  │                                         │                 │
  │ THE DAY A WRITE FEATURE SHIPS:          │                 │
  │  ★ RISK 3: no idempotency              │ data corruption │
  │                                         │ duplicate writes│
  │                                         │                 │
  │ UNDER TAB-CLOSE EDGE CASES:             │                 │
  │  RISK 5: sessionStorage tab-only        │ one user        │
  │  RISK 7: no NDJSON resume               │ one user        │
  │                                         │                 │
  │ ALREADY MITIGATED (lesson worth keeping):│                │
  │  RISK 9: parallel-eval race            │ corrupt results │
  │    fix: EVAL_RUN_TAG (already in place) │ (mitigated)     │
  │                                         │                 │
  │ NEVER FOR THIS WORKLOAD:                │                 │
  │  RISK 6: fixed 60s TTL                  │ none today      │
  │                                         │                 │
  └─────────────────────────────────────────┴─────────────────┘

  the top 4 (RISKs 1, 2, 3, 10) are the ones worth fixing first;
  everything below is honest about the bound on impact
```

---

## Implementation in codebase

| Risk | File | Line(s) | What to look at |
|------|------|---------|-----------------|
| 1 (CRITICAL) | `lib/state/insights.ts` | 4-6 | per-process Map; no cross-instance link |
| 1 | `lib/state/investigations.ts` | 11, 22-41 | mem-first fallback chain; misses on cold instance |
| 1 | `app/api/agent/route.ts` | 37-62 | `resolveAnomaly` — the fallback chain that silently misses |
| 2 (HIGH) | `lib/data-source/bloomreach-data-source.ts` | 190-205 | `liveCall` — no `AbortSignal.timeout` composed in (the Olist side has it) |
| 2 | `app/api/agent/route.ts` | 20 | `maxDuration = 300` — the only ceiling on Bloomreach side |
| 3 (HIGH cond.) | `lib/data-source/types.ts` | 38-40 | `DataSourceCallOptions` has no idempotency key field |
| 3 | `lib/agents/base.ts` | 144-156 | tool-call dispatch — no per-call idempotency |
| 4 (MED) | `lib/agents/base.ts` | 102 | `anthropic.messages.create` — no retry wrapper |
| 5 (MED) | `lib/hooks/useInvestigation.ts` | 18-19, 137-140 | sessionStorage handoff — tab-only |
| 5 | `app/api/agent/route.ts` | 228-230 | the "no diagnosis was handed over" throw |
| 6 (LOW) | `lib/data-source/bloomreach-data-source.ts` | 145 | `ttl = options.cacheTtlMs ?? 60_000` — no callsite overrides |
| 7 (LOW) | `app/api/agent/route.ts` | 169-264 | stream has no event ID or resume |
| 7 | `lib/hooks/useInvestigation.ts` | 184-208 | consumer has no Last-Event-ID logic |
| 8 (LOW ext.) | external | — | no circuit breaker on `BloomreachDataSource` for non-429 |
| 9 (LOW mit.) | `eval/scripts/run-detection.ts` | 87-100 | namespace separation via EVAL_RUN_TAG (convention, not enforcement) |
| 10 (MED) | `lib/data-source/olist-data-source.ts` | 93-197 | subprocess lifecycle: leak / no respawn / silent dispose |
| 10 | `app/api/briefing/route.ts` | 312-314 | the dispose-in-finally pattern that future routes must copy |

---

## The first three fixes (recommended priority)

If you had a week:

1. **Vercel KV-backed state store.** Swap `lib/state/insights.ts`'s `Map` and `lib/state/investigations.ts`'s `mem` for KV reads/writes keyed by `bi_session + id`. Fixes RISK 1 outright and partially fixes RISK 5 (diagnosis handoff can also live in KV). Probably 100-150 lines of code with tests.

2. **Per-tool timeout in `BloomreachDataSource`.** Mirror the Olist pattern: compose `AbortSignal.timeout(30_000)` with the existing `options.signal` in `liveCall`. Throw `McpToolError` with timeout detail. Closes the adapter asymmetry — both sides will have the same per-call deadline. Fixes RISK 2. ~10 lines.

3. **Anthropic retry wrapper.** Wrap `anthropic.messages.create` in `lib/agents/base.ts` with up to 2 retries on 5xx and 429 with 1s + 5s backoff. Fixes RISK 4. ~20 lines.

After these three, the codebase's distributed-systems posture goes from "honestly named hackathon-scale" to "production-aware single-tenant." The remaining work (idempotency for writes, circuit breaker, SSE with resume, subprocess respawn) becomes feature-driven rather than infrastructure-driven.

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
- `02-partial-failure-timeouts-and-retries.md` — RISK 2 in mechanism depth; the adapter asymmetry
- `03-idempotency-deduplication-and-delivery-semantics.md` — RISK 3 in mechanism depth
- `04-consistency-models-and-staleness.md` — RISK 5 in mechanism depth
- `05-replication-partitioning-and-quorums.md` — RISK 1's structural cause; RISK 9 (the parallel-eval anecdote)
- `10-transport-agnostic-protocol-design.md` — RISK 10 in mechanism depth (subprocess lifecycle)
- `.aipe/study-system-design/audit.md#system-design-red-flags-audit` — the system-design twin of this audit
- `.aipe/study-security/` — security-shaped risks at the same boundaries

---
Updated: 2026-06-16 — RISK 2 reframed as adapter-asymmetric (Olist fixed, Bloomreach not); added RISK 9 (parallel-eval race + EVAL_RUN_TAG mitigation) and RISK 10 (subprocess lifecycle); table extended with both new risks; "first three fixes" updated to point at the now-mirrorable Olist timeout pattern.
