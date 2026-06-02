# Scale bottlenecks and evolution

**Industry name(s):** scale audit · "what breaks first at 10x" · capacity ceiling · evolution path
**Type:** Industry standard · Language-agnostic

> blooming insights breaks in **three predictable places** as load grows, and they break in a specific order: **at 10x users (concurrent), the in-memory `Map`s become unreliable** (every user generates a new briefing, replacing the global insights Map → race conditions where user A sees user B's insights flicker through their feed); **at 100x users, the Bloomreach 1 req/s/user rate limit holds** (per-user-scoped, so doesn't multiply) **but the 300s Vercel route budget gets exceeded** when rate-limit retries pile up and Anthropic latency varies; **at 1000x or "yesterday's anomalies," the absence of a database is the wall** — no history exists, no shared feeds are possible, no audit trails. The bottlenecks are NOT compute or bandwidth — they're (1) state being process-local, (2) the 300s budget being a hard ceiling, and (3) the data shape (transient, no history) being a product limit. Each has a different fix that costs a different amount; this file ranks them.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Scale audits are usually wrong because they assume one dimension (users-per-second) and ignore others (data-per-user, time-per-request, dependency-rate-limit). The honest audit names *which dimension breaks first*, what code change fixes it, and what other dimensions force a deeper rewrite. For this codebase, the dimensions that matter are: **concurrent users on one instance** (race on insights Map), **the 300s budget** (against rate-limit retries + Anthropic variance), and **product capabilities** (history, shared feeds, audit trails — all of which require persistent storage we don't have).

```
  Zoom out — where the scale ceilings live          ← we are here (every band, ranked by what breaks first)

  ┌─ UI ─────────────────────────────────────────────┐
  │  no scale issue here; React + Vercel CDN scale    │
  │  trivially per user                                │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Route ────────────▼──────────────────────────────┐
  │  300s maxDuration is a hard CEILING               │  ← breaks at 100x under
  │  no queueing — every agent run is in-band          │     rate-limit retry pressure
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop ────────▼─────────────────────────────┐
  │  maxToolCalls cap bounds per-call latency          │
  │  per-agent Anthropic latency is the visible cost   │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider ──────────▼─────────────────────────────┐
  │  McpClient cache absorbs repeats per user          │
  │  1 req/s/user GLOBAL is the hard rate ceiling      │  ← per-user, so doesn't multiply
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ State ─────────────▼─────────────────────────────┐
  │  In-memory Map<id, Insight> — RACE at 10x         │  ★ breaks first
  │  In-memory Map<id, AgentEvent[]> — instance-bound  │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Bloomreach (their problem to scale)              │
  │  Anthropic (their problem to scale)               │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's the first thing that breaks at 10x users, what's the second at 100x, and what change in product capability would force a complete rearchitecture?* The audit is in three sections: the **10x bottlenecks** (real issues today, real fixes), the **100x bottlenecks** (visible at modest scale, require infrastructure), and the **product-shape bottlenecks** (require a database, force the biggest changes).

---

## Structure pass

**Layers.** Same five bands, but scale concerns cluster differently than failure concerns. UI scales for free; route is bounded by the 300s budget; agent loop is bounded by Anthropic latency; provider is bounded by Bloomreach's rate limit; state is bounded by the in-memory `Map` per-instance.

**Axis: ceiling height — what's the actual capacity limit at this layer?** Hold one question constant across the bands: *given today's code, how much more load could this layer take before it breaks, and what's the breakage mode?* Ceiling height is the right axis for scale because the *defining* property of a bottleneck is how soon it appears. Cost is downstream (a higher ceiling usually costs more); failure (file 06) is sibling (some failure modes only appear at scale, like contention races).

**Seams.** Two with sharp transitions where the ceiling moves dramatically.

- **SC1: per-instance ↔ shared store.** Moving the insights Map from in-memory to Vercel KV (or Redis) takes the ceiling from "few concurrent users per instance" to "shared across all users." This is the biggest leverage move — small code change, removes the highest-frequency breakage.
- **SC2: in-band agent run ↔ queue + worker.** Moving the agent execution from synchronous (inside the 300s route budget) to async (kicked off, worker runs it, client subscribes) takes the ceiling from "must complete in 5 minutes" to "no time limit." This is the bigger move — bigger code change, removes the next breakage tier and opens product capabilities (cancellable runs, mid-day resume).

```
  Structure pass — ceiling transitions

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  UI · Route · Agent · Provider · State · External       │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  ceiling height: how much load until this breaks?       │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  SC1: per-instance Map → shared store (KV/Redis)       ★│
  │  SC2: in-band agent → queue + worker                    │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You've shipped apps that work for 1 user and worked for 100 with no changes (CDN + sticky-session-free design). The mental shape there: "if I scale horizontally, the app keeps working because nothing in the request requires anything to live beyond the request." This codebase is *almost* that, with three exceptions: the insights Map (per-instance), the 300s budget (per-request), and the absence of a database (per-product). Each exception is a ceiling.

```
  Pattern — the three ceilings, ranked

  CEILING 1 — concurrent users sharing one instance
              breaks when: 2+ users land on the same Vercel instance and both
                           trigger /api/briefing within seconds of each other
              effect:      putInsights does insights.clear() — user A's briefing
                           wipes user B's mid-render; the feed flickers
              first felt:  ~10 concurrent users on the same warm instance
              fix:         move insights state to a shared store keyed by sessionId

  CEILING 2 — 300s route budget vs rate-limit retry burst
              breaks when: Bloomreach is slow + several MCP calls in one request
                           hit the rate limit + each retries up to 30s
              effect:      route exceeds 300s; Vercel kills it; client sees a
                           network error mid-stream
              first felt:  ~100 concurrent users globally (more retries fired)
              fix:         circuit breaker + move the heavy work to an async worker

  CEILING 3 — product capabilities requiring history/share
              breaks when: anyone asks for "last week's anomalies" or
                           "share this feed with my team"
              effect:      can't be built — no durable storage for derived data
              first felt:  the day product asks for it (this is feature-shaped,
                           not load-shaped)
              fix:         add a KV (for share) or Postgres (for history + share)
```

### Move 2 — each ceiling, with the breakage and the fix

#### Ceiling 1 — concurrent users sharing one instance (breaks at ~10x)

The most subtle ceiling because it's a *correctness* issue (race) disguised as a scale issue.

```
  The race — putInsights.clear() across users

  T=0    user A: /api/briefing starts; instance X serves it
  T=5s   user A's briefing emits coverage_item events; client renders grid
  T=10s  user B: /api/briefing starts; ROUTES TO SAME INSTANCE X (load balancer)
  T=12s  user A's monitoring agent emits anomalies; putInsights(A's anomalies)
  T=15s  user B's monitoring agent emits anomalies; putInsights(B's anomalies)
                                                       │
                                                       ▼
                                              insights.clear()  ← WIPES A's
                                              insights.set(B's)
  T=20s  user A clicks one of "their" insights; route lookup finds B's by id mismatch
  T=21s  user A sees 404 or someone else's investigation
```

The `insights` Map is **global to the instance**, not keyed by session. The `clear()` is correct for "this user's freshest briefing replaces this user's stale one" but wrong for "user A's briefing replacing user B's." Today this is rare because (1) traffic is tiny, (2) Vercel routes most users to fresh instances under load, and (3) the demo mode doesn't touch the live path. As traffic grows it becomes more frequent and shows up as the feed flickering or the investigation page 404'ing.

**The fix.** Key the insights Map by `sessionId` instead of being a global Map. `Map<sessionId, Map<insightId, Insight>>`. The session id is already present (lib/mcp/session.ts), the change is local to `lib/state/insights.ts` (~30 LOC). This is the smallest scale-fix in the audit and the highest priority.

```
  The fix — session-keyed insights Map

  before: const insights = new Map<string, Insight>();          ← global
  after:  const insights = new Map<string, Map<string, Insight>>();  ← per session
          // putInsights(items, sessionId)
          // getInsight(id, sessionId)
          // listInsights(sessionId)
  cost:   ~30 LOC change in lib/state/insights.ts + every call site
          (briefing route, agent route's resolveAnomaly)
  buys:   removes the race; ceiling moves from "few concurrent on one instance"
          to "Vercel instance memory bound" (much higher)
```

#### Ceiling 2 — the 300s route budget vs rate-limit retry pressure

```
  Today's per-investigation latency breakdown (typical)

  bootstrapSchema       4 sequential MCP calls × ~1.1s spacing = ~5s
  monitoring scan       6 MCP calls × ~1.1s + Anthropic between = ~15-25s
  diagnostic agent      6 MCP calls × ~1.1s + Anthropic = ~30-50s
  recommendation agent  4 MCP calls × ~1.1s + Anthropic = ~20-40s
  TOTAL (combined run)                                   ~70-120s typical
                                                          ~250s worst-case
```

The 300s budget has ~50-80s of headroom under normal conditions. That headroom evaporates when:

- Bloomreach is slow today (their problem; we wait at 1.1s spacing, not 1.1s response)
- Several MCP calls hit the rate limit and each retries up to 30s (3 retries × 10s window)
- Anthropic latency spikes (typical 1-3s per turn; spikes to 5-10s)

A *single* MCP call that retries 3 times costs 30s. Two of those in one investigation costs 60s. With 70-120s of headroom, two such calls is the edge. At 100x users globally, the chance that two retries hit in one investigation goes up (more concurrent users → more rate-limit pressure → more retries). The 300s budget becomes the first thing to break.

**The fix.** Two-stage. **Short-term: circuit breaker** — after N consecutive 5xx from a tool, fail fast for 30 seconds. ~50 LOC, no external dependency. **Long-term: async worker pattern** — POST to start an investigation, return 202 with a stream URL, worker runs the agent (no Vercel route timeout), client subscribes via SSE or polls. Big change (queue, worker, durable state for in-progress runs), but removes the 300s ceiling entirely.

#### Ceiling 3 — product-shape ceiling (history, sharing, audit)

This isn't a load ceiling at all — it's a *feature ceiling*. Three capabilities the architecture can't support:

```
  Capability                          Why blocked              Smallest fix
  ─────                               ─────                     ─────
  "yesterday's anomalies"             no persistent storage     KV w/ 7-day TTL ($)
                                      for derived data          Postgres for history ($$)

  "share this feed with my team"      no cross-user storage     KV keyed by orgId ($)
                                      no concept of "team"      auth model + DB ($$$)

  "audit: who saw which insight"      no record outside Vercel  structured log + analytics
                                      function logs             pipeline ($$)
```

These break the day product asks for them. The ARCHITECTURE doesn't prevent them — adding a KV is a few hundred lines and one external service — but they're invisible until requested because the codebase doesn't have placeholders for them. Naming them here makes the "what's missing" visible.

### Move 2.5 — current vs evolved state, side by side

```
  Current architecture                       Evolved (at 100x + history product)
  ─────                                      ─────

  ┌─ UI ───────────────────┐                ┌─ UI ────────────────────────────┐
  │  fetch NDJSON          │                │  fetch NDJSON (live)             │
  │  no offline             │                │  + subscribe to in-progress runs │
  │                         │                │  + history view (paginated)      │
  └──────────┬──────────────┘                └─────────────┬───────────────────┘
             │                                              │
  ┌─ Route ──▼──────────────┐                ┌─ Route ─────▼───────────────────┐
  │  in-band agent run      │                │  POST /api/investigate         │
  │  300s budget hard cap   │                │  → enqueue, return 202+stream   │
  │  no circuit breaker     │                │  + circuit breaker on Bloomreach│
  └──────────┬──────────────┘                └─────────────┬───────────────────┘
             │                                              │
  ┌─ Agent loop ────────────┐                ┌─ Worker ────▼───────────────────┐
  │  inside the route       │                │  separate process               │
  │  same Vercel function   │                │  no timeout; full investigations │
  └──────────┬──────────────┘                └─────────────┬───────────────────┘
             │                                              │
  ┌─ State ──▼──────────────┐                ┌─ Storage ───▼───────────────────┐
  │  in-memory Map (race)   │                │  KV: live insights by session    │
  │  no history              │                │  Postgres: insight history       │
  └──────────┬──────────────┘                └─────────────┬───────────────────┘
             │                                              │
  ┌─ McpClient ─────────────┐                ┌─ McpClient ─────────────────────┐
  │  unchanged              │                │  unchanged (still rate-limited)  │
  └──────────┬──────────────┘                └─────────────┬───────────────────┘
             │                                              │
  ┌─ Bloomreach ────────────┐                ┌─ Bloomreach ────────────────────┐
  │  unchanged              │                │  unchanged                       │
  └────────────────────────┘                 └─────────────────────────────────┘

  What DOESN'T change:                       What CHANGES:
  - McpClient (cache + retry)                - State: KV + Postgres
  - the agent loop pattern                   - Route: enqueue + subscribe
  - the NDJSON wire format                   - Worker: long-running execution
  - the schema-gate                          - Circuit breaker
  - the agent prompts                        - Auth model (for teams)
```

The migration cost is real — adding a queue, a worker, a KV, a Postgres, and the auth model for teams — but the agent layer and the McpClient stay almost identical. The architecture's lower bands are stable; the upper bands (state, route, UI) are what evolve.

### Move 3 — the principle

**Pick the smallest fix that moves the ceiling that's actually hitting you.** This codebase has three ceilings, and the *order they break in* is fixed (Ceiling 1 first at ~10x, Ceiling 2 next at ~100x, Ceiling 3 only on product demand). The correct order to fix is the same — Ceiling 1 with a 30-LOC change is high leverage; Ceiling 2 requires a queue, weeks of work, only if traffic justifies it; Ceiling 3 only when product asks. The mistake is to fix Ceiling 3 first because it "feels architecturally correct" — that's adding Postgres before you need it, paying ops cost for capability you don't ship. The right move is *the smallest move that buys the next user* and *defer the bigger moves until they're earning their cost*. The lesson generalizes: scale audits are about ranking, not about engineering the maximum-possible-system.

---

## Primary diagram

The full scale topology — every ceiling, every breakage trigger, every fix path.

```
  Scale ceilings — what breaks at each load level, in order

  LOAD               BREAKS                       FIX                              EFFORT
  ─────              ─────                        ─────                             ─────
  1 user             nothing                       —                                 —

  2-10 concurrent    rare race on insights.clear() across users                     [ defer ]
  users on same      (feed flicker; investigation 404 if user clicks across boundary)
  instance

  10-100 concurrent  insights Map race becomes frequent   ★ FIX 1: session-keyed   ~30 LOC
                                                          insights Map              local change
                                                          (lib/state/insights.ts)

  100+ concurrent    Bloomreach rate-limit retry          ★ FIX 2a: circuit         ~50 LOC
  global             pressure pushes route                breaker on McpClient      local change
                     past 300s budget; routes
                     killed mid-stream

  1000+ concurrent   300s budget unbounded                ★ FIX 2b: queue + worker  weeks
  global +           by feature flexibility                async investigations      external service
  long-running                                            cancellable runs
  agent runs                                              durable in-progress state

  ANY scale +        "yesterday's anomalies"               KV (for live shared      ~200 LOC
  history feature    "share this feed"                    feeds across users)        + ext service ($5/mo)
                     "audit who saw what"

  ENTERPRISE         multi-tenant, accounts,              Postgres + auth model     months
                     RBAC, audit trails                                              architectural change

  ─────              ─────                                ─────                      ─────

  The architecture's STABLE pieces (don't change with scale until enterprise):
  ✓ McpClient (cache + spacing + retry)
  ✓ runAgentLoop (the shared tool-use loop)
  ✓ the four agents (prompt + tool subset + validator)
  ✓ the NDJSON wire format
  ✓ schema-gated coverage
  ✓ the encrypted-cookie auth pattern
```

---

## Implementation in codebase

### Use cases

**Use case 1 — two users hit the same warm instance during the morning rush.** Both call `/api/briefing`. Both runs of `MonitoringAgent.scan` complete near-simultaneously. Both call `putInsights`. The second call's `insights.clear()` wipes the first call's data. User A reloads and sees user B's anomalies (because user A's session cookie still finds the insight ids, but those ids now point at user B's data). This is *the race* — Ceiling 1.

**Use case 2 — a customer's Bloomreach project is having a slow day.** Their server takes 5+ seconds per `execute_analytics_eql` instead of the usual ~1s. An investigation that normally runs ~80s now runs ~120s. Add 2 rate-limit retries at ~12s each = ~150s. Add Anthropic latency variance = ~180s. We're still under the 300s budget, but the next slow day plus one retry burst pushes a request past 300s and Vercel kills it mid-stream. This is Ceiling 2 — invisible until it isn't.

**Use case 3 — product asks "can we email users a weekly summary of anomalies?"** Today: impossible. There's no record of what anomalies fired this week — each briefing replaces the last. The architecture has no place to write the weekly aggregate to and no mechanism to send email. Adding the capability requires (a) durable storage for the weekly aggregate, (b) a scheduled job (Vercel Cron), (c) an email provider. The product ask is reasonable; the architectural cost is non-trivial. This is Ceiling 3.

### Scale concern file index

| Ceiling | File · Concern | Lines | Today's behavior |
|---|---|---|---|
| 1 (race) | `lib/state/insights.ts` · `putInsights` clears global Map | L30–L42 | Per-instance, not per-session |
| 1 (race) | `lib/state/insights.ts` · `getInsight` reads global Map | L44–L46 | No session scoping |
| 2 (budget) | `app/api/agent/route.ts` · `maxDuration = 300` | L20 | 300s hard cap |
| 2 (budget) | `app/api/briefing/route.ts` · `maxDuration = 300` | L17 | 300s hard cap |
| 2 (rate retry pressure) | `lib/mcp/client.ts` · retry loop | L121–L132 | 3 × ~10-20s = up to 60s on a single call |
| 2 (no circuit breaker) | `lib/mcp/client.ts` · NO breaker | — | Always retries even when Bloomreach is fully down |
| 3 (no history) | `lib/state/insights.ts` · transient | — | Replaced each briefing |
| 3 (no share) | `lib/state/insights.ts` + session model | — | Map global to instance, no cross-user concept |
| 3 (no audit) | `app/api/*/route.ts` · `console.error` only | — | Vercel function logs only; no structured event log |

### Sample — the race-prone insights Map

```
  lib/state/insights.ts  (lines 4, 30–42)  ← annotated

  const insights = new Map<string, Insight>();      ← GLOBAL to the instance, not per session
  const investigations = new Map<string, Investigation>();
  const anomalies = new Map<string, Anomaly>();

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing — each run IS the current feed, not an
    // addition. Without clearing, a warm serverless instance (or a long-running
    // dev server) accumulates stale insights from earlier runs, so the feed shows
    // yesterday's anomalies alongside today's. Investigations are keyed separately
    // and untouched here.
    insights.clear();              ← correct for one user; race for two
    anomalies.clear();
    items.forEach((i, idx) => {
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ this 12-line function is THE CEILING-1 hotspot. The clear() is
          load-bearing for freshness (the feed should be "this run's
          insights") but in a multi-user-on-one-instance world it wipes
          another user's data. Fix: key by sessionId. The change is local
          to this file + every call site (3 files: briefing route, agent
          route's resolveAnomaly, the listInsights call in briefing).
```

### Sample — the 300s budget with no observability

```
  app/api/agent/route.ts  (lines 18–20)  ← annotated

  // 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
  // runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
  export const maxDuration = 300;
       │
       └─ ONE LINE that pins the entire latency model. 300s is the wall.
          We have ~120s typical for a combined run. ~180s headroom is fine
          today; one slow Bloomreach day + 2 retries eats that. There is
          NO instrumentation tracking time-to-each-event, so the day we
          start hitting the wall, we'll see "Vercel killed request" with
          no idea which phase ate the time. The fix is two parts:
          (1) console.time-style instrumentation around each phase, and
          (2) the circuit breaker so retries don't pile up.
```

---

## Elaborate

### Why the rate limit doesn't multiply

Bloomreach's rate limit is **per user, globally** — not "per session" or "per request from your app." Two concurrent users each have their own 1 req/s budget. Adding more users doesn't tighten any one user's budget. So the rate limit is *not* a scale concern in the traditional sense — it's a per-user latency floor, not a global throughput ceiling. This is why Ceiling 1 (in-memory Map race) appears before any rate-limit-driven Ceiling 2 issue: the Map is shared per instance, but the rate limit is shared per user. Two users on one instance hit the Map race long before either hits a rate-limit-related budget issue.

### Why the budget isn't compute-bound

The agent layer's CPU work is tiny — JSON parse, JSON stringify, type guards. The visible latency is entirely *waiting*: 1.1s spacing per MCP call + 1-3s per Anthropic call + retries. Vertical scaling (bigger Vercel function) buys nothing because we're not CPU-bound. The fix for the budget isn't "more compute" — it's "less waiting" (caching, parallelism where allowed) or "more budget" (move work out of the route into a worker).

### What the smallest meaningful fix is

For 90% of foreseeable growth: **session-key the insights Map.** ~30 LOC. Removes the only correctness issue at modest scale. Doesn't add infrastructure. Doesn't change the user-visible behavior. This is the audit's top recommendation if exactly one thing got done.

For the next 9%: **circuit breaker on McpClient.** ~50 LOC. Same file. No external dependency. Prevents the 300s budget from being eaten by retries when Bloomreach is fully down.

The remaining 1% (the queue, the durable storage, the team model) lives in a different epoch of the product — when traffic and feature demand justify the operational cost.

### What this audit doesn't cover

- **Bandwidth.** NDJSON streams are small; the largest single event is a serialized tool result truncated at 4KB. A briefing's full stream is <100KB. No bandwidth concerns.
- **Vercel function memory.** The in-memory Maps hold <1MB even with 1000 insights. No memory pressure.
- **Anthropic cost at scale.** Each agent run costs $0.20-0.50 in tokens. At 100 investigations/day that's $20-50/day. Not architectural — operational.
- **MCP server scaling.** Bloomreach's problem. We're a single read-only client.

### Cross-link to legacy mechanism teaching

- The McpClient cache + spacing + retry that bounds per-call latency → `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md`
- The schema-gated coverage that prevents wasted budget on unsupported categories → `.aipe/study-system-design-dsa/01-system-design/08-schema-gated-coverage.md`
- The encrypted-cookie auth that enables horizontal scaling across Vercel instances → `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`

---

## Interview defense

**What they are really asking:** can you name what breaks first as load grows, can you rank the fixes by leverage, and can you defend NOT building scale infrastructure today?

---

**[mid] — What breaks first at 10x users?**

The insights Map race. Today, `lib/state/insights.ts` holds one global Map per Vercel instance, and `putInsights.clear()` is correct for one user but wipes another user's data when two land on the same warm instance. The user-visible effect is feed flicker or 404s when investigating across the boundary. The fix is a 30-line change: key the Map by `sessionId`. The session id is already present (`lib/mcp/session.ts`). I'd do this first if traffic grew.

```
  Today: const insights = new Map<string, Insight>();          GLOBAL
  Fix:   const insights = new Map<string, Map<string, Insight>>();  per session
  Cost:  ~30 LOC; no infra change; no UX change
```

---

**[senior] — What breaks at 100x and why isn't it the rate limit?**

The 300s route budget breaks under retry pressure. Bloomreach's rate limit is per-user globally — it doesn't multiply with concurrent users; each user has their own 1 req/s budget. But globally, more users mean more rate-limit hits across the fleet, more retries firing, and the variance compounds. A retry costs ~12s (parsed window + cushion). Two retries on one investigation costs ~24s, and we have ~180s of headroom against a 70-120s typical run. On a bad Bloomreach day plus a multi-user moment, we eat the headroom and the route gets killed at 300s, mid-stream. The fix is two parts: (1) a circuit breaker on `McpClient` so we fail fast when Bloomreach is fully down instead of burning 3 retries × 12s, and (2) eventually moving the agent run to an async worker with no 300s ceiling.

---

**[arch] — What forces a complete rearchitecture?**

A product change. Specifically: "show me history," "share this feed with my team," "audit who saw what." Any of these breaks the current architecture because there's no durable storage for derived data. Today, every insight is a transient projection of Bloomreach data — they exist for the lifetime of the briefing, then they're gone. The smallest add is Vercel KV (or Upstash Redis) keyed by sessionId or orgId for live shared feeds — ~$5/month, ~200 LOC. For history (last week's anomalies), I'd go straight to Postgres — at that point we have a real data model and we should treat it as one. The architectural cost is real, but the ceiling is feature-shaped, not load-shaped: it breaks when product asks, not when traffic grows.

---

**The dodge — "shouldn't you build a database in now?"**

No, and the discipline of not adding it is the architecture's strongest feature. We don't have history, share, or audit features — adding Postgres before any of those exist would be paying ops cost (managing the DB, migrations, connection pooling, backup) for capability nobody can use. The day product asks for history, I add it. Until then, the absence of a database is *correct* — the system is honestly aligned with what it can do.

```
  add a DB         when product asks for it (not when you'd "feel right")
  add a queue      when 300s budget actually fails (not when "queues feel right")
  add a circuit    when one user's slow Bloomreach hurts another (today: no concurrency)
```

---

**One-line anchors:**
- Three ceilings, in fixed order: insights Map race (10x), 300s budget vs retry pressure (100x), feature-shaped (any scale + product ask).
- The smallest fix that moves the highest-leverage ceiling is session-keying the insights Map (~30 LOC).
- McpClient and runAgentLoop are stable across all three migrations — the lower bands don't change with scale.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, name the three ceilings in order of when they break. For each, name the fix and the rough effort. Check against the primary diagram.

### Level 2 — Explain
Why doesn't the Bloomreach rate limit get tighter as we add more users? Reference `lib/mcp/client.ts` L82–L96 and the per-user-globally property.

### Level 3 — Apply
A teammate proposes adding "watchlist" — pin an insight and re-evaluate it every hour. Walk through which ceilings this hits, which need fixing first, and whether the current architecture supports it at all. Reference `lib/state/insights.ts` and the absence of a scheduler.

### Level 4 — Defend
Defend the choice to NOT build a queue + worker today. When is the cost worth it, when isn't it, and what's the trigger that would tip you over?

### Quick check
- Which file holds Ceiling 1? → `lib/state/insights.ts` L4 (global Map) + L30–L42 (clear+set)
- Which constant is Ceiling 2's hard wall? → `maxDuration = 300` in both route files
- Which feature requires breaking Ceiling 3? → history, share, audit — any of the three
- Which lower-band piece doesn't change across all migrations? → `McpClient`, `runAgentLoop`, the NDJSON wire format, the schema-gate

---

## See also

→ [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [05-storage-choice-and-durability-boundaries.md](./05-storage-choice-and-durability-boundaries.md) · [06-failure-handling-and-reliability.md](./06-failure-handling-and-reliability.md) · [08-system-design-red-flags-audit.md](./08-system-design-red-flags-audit.md) · `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` (the McpClient mechanism) · `.aipe/study-system-design-dsa/01-system-design/08-schema-gated-coverage.md` (the gate that prevents wasted budget)
