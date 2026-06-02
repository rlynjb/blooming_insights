# System design red flags audit — the capstone

**Industry name(s):** architectural red flags · design-review checklist · "system-design smells that fire here"
**Type:** Industry standard · Language-agnostic

> System-design red flags as a ranked review checklist, each marked against this codebase: **fires** (with the file path, the severity for THIS repo, and the move), **doesn't fire** (with why — those are praise, also findings), or **N/A** (codebase too small to tell). This is the actionable, ranked index that the seven other concept files feed. The top three risks are: **(1) in-memory state in a serverless instance world** (the insights Map race becomes real at 10x users — 30-LOC fix), **(2) the McpClient retry budget vs the 300s route budget** (one slow Bloomreach day can push a request past the ceiling — needs a circuit breaker), **(3) no observability on the 300s budget** (the day we hit the wall, we'll have no idea which phase ate the time). Each is named with the file, the severity, and the one-line fix.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This file collapses every finding from files 01–07 into a single sorted checklist. Every row is either "fires here, with a fix" or "doesn't fire, here's why (and that's praise)." The ranking is by severity *for this codebase, today* — not the textbook worst-case. A small architecture like this one weights `state-in-serverless` above, say, `no_circuit_breaker` because the first hits at 10 users while the second hits at 100.

```
  Zoom out — the system-design red-flags checklist as one frame

  ┌─ The 12 red flags evaluated ─────────────────────────────────────┐
  │  FIRES (5, ranked)                                                │
  │   #1 in-memory state in serverless (insights Map race)  CRITICAL  │
  │   #2 retry budget vs route budget (no circuit breaker)  HIGH      │
  │   #3 no observability on the 300s ceiling               HIGH      │
  │   #4 schema cache has no TTL (incidental invalidation)  MEDIUM    │
  │   #5 fetch can't be cancelled (useInvestigation)        LOW       │
  │                                                                   │
  │  FIRES MINOR (2)                                                  │
  │   #6 single rate-limit retry budget per-call (no global) LOW      │
  │   #7 dev-only filesystem persistence is fragile          LOW      │
  │                                                                   │
  │  DOESN'T FIRE — PRAISE (4)                                        │
  │   - distributed monolith (this is a clean monolith)              │
  │   - cargo-cult Kafka (no queue we don't need)                    │
  │   - god object (no — agents are 4 small classes)                 │
  │   - distributed transactions (no — there's no DB)                │
  │                                                                   │
  │  N/A — codebase doesn't exercise enough (2)                       │
  │   - sticky sessions (no session affinity assumed; cookie does job) │
  │   - cross-service contracts (one process; no inter-service comms) │
  └───────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *if you had one afternoon and could change one thing about this architecture, what would buy the most reliability/scale headroom for the least cost?* The answer is at the top of FIRES. Below it, ranked, is the rest of the work. Below that, what's working well (so you don't accidentally break it). The next sections walk each row.

---

## Structure pass

**Layers.** No layered structure — this is the projection of files 01–07 onto a single ranked list. The structural work happened in the earlier files.

**Axis: severity for *this codebase*, today.** Not the textbook worst-case severity, but the practical "if the next contributor reads only one finding, which one matters most for them at the current traffic level." This biases toward hotspots that fire at modest scale (Ceiling 1 from file 07) above ones that fire only at large scale (Ceiling 2) and far above ones that don't fire at any current scale (some textbook "distributed-systems" smells don't apply because we have one process).

**Seams.** One implicit. The line between FIRES (with the move) and DOESN'T FIRE (with the praise). Both halves are findings; neglecting either has a cost. Naming what's healthy is how you avoid accidentally introducing a smell on the next change.

```
  Structure pass — the ranking lens

  ┌─ 1. LAYERS ─────────────────────────────────────────────────┐
  │  one layer: the projection of files 01–07 onto severity     │
  └────────────────────────────┬────────────────────────────────┘
                               │
  ┌─ 2. AXIS ──────────────────▼────────────────────────────────┐
  │  severity for THIS codebase, TODAY (not textbook worst-case) │
  └────────────────────────────┬────────────────────────────────┘
                               │
  ┌─ 3. SEAMS ─────────────────▼────────────────────────────────┐
  │  S1: FIRES (with fix)  vs  DOESN'T FIRE (with praise)        │
  │      neither half is optional                                 │
  └─────────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the checklist as a tool

You know how a pre-flight checklist works — pilots don't *remember* to check fuel, they read down the list and the list says "fuel." Same shape here. The red-flags checklist is a tool to hand the next contributor: every row is "look for THIS in your change; if it's present, the fix is THIS; if it's absent, leave it alone."

```
  The checklist shape

  ┌────────────────────────┐
  │ red flag name           │  ← what the smell is called
  ├────────────────────────┤
  │ where it fires here     │  ← file:line in this repo
  │ severity for this repo  │  ← critical / high / medium / low / n/a
  │ the one-line fix        │  ← what to do (or "leave alone, here's why")
  └────────────────────────┘
```

### Move 2 — the ranked checklist

The 12 system-design red flags from the audit, each marked against this codebase. Severity reflects pain for THIS repo's users today, not abstract worst-case.

```
╔════════════════════════════════════════════════════════════════════════════╗
║ #1 ─ IN-MEMORY STATE IN A SERVERLESS WORLD          SEVERITY: CRITICAL      ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/state/insights.ts L4 — `const insights = new Map<string, Insight>();`║
║        is GLOBAL to the instance, not keyed by session. `putInsights.clear()`║
║        (L36) wipes one user's data on another user's briefing, when two land║
║        on the same warm Vercel instance.                                    ║
║ EFFECT: race condition. User A's feed flickers, then shows user B's anomalies║
║        (because user A's insight ids no longer exist in the Map). User A    ║
║        clicks "investigate" → 404 or someone else's data.                   ║
║ FIRST FELT AT: ~10 concurrent users on the same warm instance.              ║
║ FIX:   key the Map by sessionId: `Map<sessionId, Map<insightId, Insight>>`. ║
║        ~30 LOC change local to lib/state/insights.ts + 3 call sites         ║
║        (briefing route, agent route's resolveAnomaly, listInsights call).   ║
║        No infra change. No UX change.                                       ║
║ SEE:   file 03 (state ownership), file 07 (Ceiling 1).                      ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #2 ─ RETRY BUDGET vs ROUTE BUDGET (no circuit breaker)  SEVERITY: HIGH      ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/mcp/client.ts L121–L132 — McpClient retries up to 3× with each   ║
║        wait capped at retryCeilingMs=20s. A single MCP call that retries 3× ║
║        can cost ~36s. Two such calls in one investigation cost ~60s — over  ║
║        a typical 70-120s run, that pushes towards the 300s route budget     ║
║        (app/api/agent/route.ts L20). There's NO circuit breaker — if        ║
║        Bloomreach is fully down, every call burns the full retry budget     ║
║        before failing.                                                       ║
║ EFFECT: at modest scale (100+ concurrent users globally), the chance of two  ║
║        retries landing in one investigation goes up, and the 300s budget is ║
║        exceeded — Vercel kills the route mid-stream; client sees a network  ║
║        error.                                                                ║
║ FIRST FELT AT: ~100 concurrent users globally, or any sustained Bloomreach  ║
║        outage.                                                              ║
║ FIX:   add a circuit breaker to McpClient. Track consecutive 5xx; open the  ║
║        circuit after 5 in a row; fail-fast for 30s; close on first success. ║
║        ~50 LOC in lib/mcp/client.ts, no external dependency.                ║
║ SEE:   file 06 (failure handling — NOT HANDLED section), file 07 (Ceiling 2).║
╠════════════════════════════════════════════════════════════════════════════╣
║ #3 ─ NO OBSERVABILITY ON THE 300s CEILING            SEVERITY: HIGH         ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: app/api/agent/route.ts L20 and app/api/briefing/route.ts L17 set     ║
║        maxDuration=300, but there's NO console.time-style instrumentation,  ║
║        no OpenTelemetry, no structured log emission with phase timings. The ║
║        ONLY observability is console.error on catch (full stack to Vercel   ║
║        logs). McpClient.callTool returns durationMs, but nothing aggregates ║
║        or surfaces it.                                                       ║
║ EFFECT: the day a request hits the 300s wall, we'll see "Vercel killed     ║
║        request" with no idea which phase ate the time. Was it bootstrapping ║
║        the schema (5s)? Two MCP retries (60s)? Anthropic latency spikes    ║
║        (5-10s × 6 turns)? The investigation flow gives no signal.           ║
║ FIRST FELT AT: any first production incident where a request times out.     ║
║ FIX:   add structured timing logs at each phase boundary (schema bootstrap,  ║
║        coverage gate, each agent run, each MCP call). Even a console.log    ║
║        with { phase, durationMs, sessionId } would surface this in Vercel   ║
║        function logs. Real observability (Datadog, OpenTelemetry) is a      ║
║        bigger move; the minimum is ~20 LOC of `const t0 = performance.now()`║
║        pairs around each phase.                                              ║
║ SEE:   file 06 (the dodge — "have you measured production errors?"),        ║
║        file 07 (the 300s budget is the next ceiling).                       ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #4 ─ SCHEMA CACHE HAS NO TTL (incidental invalidation)  SEVERITY: MEDIUM    ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/mcp/schema.ts L131 — `let cached: WorkspaceSchema | null = null;` ║
║        is a singleton, never invalidated. The ONLY way to refresh is        ║
║        instance recycle. A warm instance serving sustained traffic for      ║
║        a customer who JUST added a new event type won't pick up the new     ║
║        category in the coverage grid until recycle.                         ║
║ EFFECT: small but real. Customer adds new event → coverage grid doesn't     ║
║        show new category → customer confused. Self-resolves on recycle      ║
║        (usually within hours to a day).                                     ║
║ FIRST FELT AT: any customer schema change on a long-warm instance.          ║
║ FIX:   add a 1-hour TTL + a `force=true` query param on /api/briefing for   ║
║        explicit refresh. ~10 LOC in lib/mcp/schema.ts + ~3 LOC in the route. ║
║ SEE:   file 04 (caching — Cache 2, the schema cache).                       ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #5 ─ FETCH CAN'T BE CANCELLED                       SEVERITY: LOW            ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/hooks/useInvestigation.ts L31–L36 (comment) + L213 — the hook    ║
║        deliberately doesn't cancel the fetch on cleanup, for a correctness  ║
║        reason (StrictMode would corrupt the trace). The cost: if the user   ║
║        navigates away mid-investigation, the agent keeps running on the     ║
║        server until it finishes (or hits maxToolCalls/maxTurns). For a      ║
║        30-90s investigation, that's wasted Anthropic + MCP budget.          ║
║ EFFECT: small monetary waste; user might come back to find a stale          ║
║        "loading" if the original tab still references the run.              ║
║ FIRST FELT AT: cost-meaningful at any sustained traffic; correctness-       ║
║        meaningful never (graceful no-op).                                   ║
║ FIX:   wire an AbortController triggered by ROUTE CHANGE (not StrictMode    ║
║        cleanup). Listen to Next's router events; abort on route change.     ║
║        ~15 LOC.                                                              ║
║ SEE:   file 06 (failure handling — Path 7).                                 ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #6 ─ RATE-LIMIT RETRY BUDGET IS PER-CALL, NOT GLOBAL  SEVERITY: LOW         ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/mcp/client.ts L121–L132 — maxRetries=3 is enforced per-call.    ║
║        A 6-tool-call investigation could in principle retry 6 × 3 = 18      ║
║        times, each up to 20s. Practically bounded by the 300s route budget,║
║        so this is mostly mitigated by Red Flag #2's fix (circuit breaker).  ║
║ EFFECT: hides Red Flag #2 — without a circuit breaker AND with per-call     ║
║        retry budgeting, sustained 5xx from Bloomreach burns 18 × 12s = 216s ║
║        of the 300s budget before the route fails.                           ║
║ FIRST FELT AT: same trigger as Red Flag #2 (Bloomreach outage at scale).    ║
║ FIX:   if Red Flag #2's circuit breaker is added, this becomes a non-issue. ║
║        Otherwise: track total retry budget across one investigation, deduct ║
║        from a per-route budget of (say) 90s.                                ║
║ SEE:   file 06 (the rate-limit retry mechanism), file 07 (Ceiling 2).       ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #7 ─ DEV-ONLY FILESYSTEM PERSISTENCE IS FRAGILE      SEVERITY: LOW          ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ FIRES: lib/mcp/auth.ts L34 + lib/state/investigations.ts L7 — the PERSIST   ║
║        gate (`NODE_ENV === 'development'`) writes to .auth-cache.json and   ║
║        .investigation-cache.json on every change. The try/catch is best-    ║
║        effort: if the FS write fails, persistence is silently lost (the     ║
║        comment says "lose persistence"). In dev that's usually fine, but    ║
║        it means a dev whose FS hits a quota (or who runs Next in a read-    ║
║        only sandbox) sees subtle "why isn't my dev OAuth state surviving    ║
║        hot reload?" bugs.                                                    ║
║ EFFECT: developer experience regression in rare circumstances; never        ║
║        affects production (PERSIST is false there).                         ║
║ FIRST FELT AT: any dev with an unusual FS setup.                            ║
║ FIX:   surface the FS write failure as a one-time console.warn so the dev   ║
║        knows persistence is degraded. ~5 LOC.                                ║
║ SEE:   file 05 (Tier 6 filesystem).                                         ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #8 ─ DISTRIBUTED MONOLITH                            SEVERITY: N/A — PRAISE  ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ DOESN'T FIRE. The codebase is one Next.js app, one deployment, one process. ║
║        The agent loop, the McpClient, the auth provider all live in the     ║
║        same memory. There's no inter-service IPC pretending to be a method  ║
║        call. This is the right call at ~5K LOC; splitting into "agent       ║
║        service" + "MCP gateway" + "auth service" would add 3 ops surfaces   ║
║        and 3 failure modes for one app one person owns.                     ║
║ PRAISE: name as a finding — the discipline of NOT splitting prematurely is  ║
║        what keeps this codebase legible.                                    ║
║ SEE:   file 01 (system map — three real boundaries, one cosmetic).          ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #9 ─ CARGO-CULT KAFKA / QUEUES                      SEVERITY: N/A — PRAISE  ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ DOESN'T FIRE. No queue. Every agent run is in-band with one HTTP request,   ║
║        bounded by the 300s budget. This is correct for today's load (1 user ║
║        at a time, no background work). Adding a queue would buy capability  ║
║        we don't ship (async investigations, mid-day resume) at the cost of  ║
║        operational complexity (queue infrastructure, worker process, durable║
║        in-progress state). The day we need async investigations, the queue  ║
║        is the right move; until then, NOT having it is the right move.     ║
║ PRAISE: discipline matters. The audit in file 07 names the upgrade path     ║
║        without recommending it today.                                       ║
║ SEE:   file 01 (cosmetic route → agent boundary), file 07 (Ceiling 2 fix).  ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #10 ─ GOD OBJECT (one class owns everything)         SEVERITY: N/A — PRAISE ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ DOESN'T FIRE. The agent layer is 4 small classes (MonitoringAgent,          ║
║        DiagnosticAgent, RecommendationAgent, QueryAgent), each ~100 LOC,    ║
║        each doing one thing. They share runAgentLoop (one function, 130 LOC)║
║        which IS arguably the most-shared piece — but it's a deep function,  ║
║        not a god object: the contract is small (the McpCaller seam +        ║
║        hooks), the body absorbs the model loop's complexity. McpClient is   ║
║        similarly deep — 172 LOC, 3 methods, all about TTL + spacing + retry.║
║        These are the textbook "deep modules" from APOSD.                    ║
║ PRAISE: name it. The shared-loop pattern is what made adding the            ║
║        RecommendationAgent in step 3 trivial — same loop, different prompt. ║
║ SEE:   file 01 (agent band — each agent = prompt + tools + validator),      ║
║        study-software-design/02-deep-vs-shallow-modules.md.                  ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #11 ─ DISTRIBUTED TRANSACTIONS / SAGA / 2PC          SEVERITY: N/A — PRAISE ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ DOESN'T FIRE. No database, no cross-service transactions, no need for       ║
║        compensating actions. The agent loop's idempotency story is "every   ║
║        tool call is read-only by construction; replays produce identical    ║
║        events." There's literally nothing to commit or roll back.           ║
║ PRAISE: the choice to be read-only-by-construction (the tool whitelist in   ║
║        lib/mcp/tools.ts) is what enables this praise — the day someone adds ║
║        a write tool, this red flag becomes a real concern.                  ║
║ SEE:   study-security/00-overview.md (read-only tool whitelist),            ║
║        study-security/07-llm-and-agent-security.md.                          ║
╠════════════════════════════════════════════════════════════════════════════╣
║ #12 ─ STICKY SESSIONS / SESSION AFFINITY            SEVERITY: N/A           ║
║ ────────────────────────────────────────────────────────────────────────── ║
║ N/A. The architecture assumes Vercel's load balancer can route requests to  ║
║        any instance; the bi_auth cookie carries OAuth state across the      ║
║        request-vs-callback boundary specifically so we DON'T need sticky    ║
║        sessions. This is by design — the codebase too small/uniform to     ║
║        meaningfully grade against "should sessions be sticky?"               ║
║ SEE:   file 03 (state ownership — bi_auth cookie is the 10-day carrier),   ║
║        file 05 (Tier 5 — the only durable production storage).               ║
╚════════════════════════════════════════════════════════════════════════════╝
```

### Move 3 — the principle

**Severity should be measured against your own codebase, today — not a textbook system at scale.** A finding that's "critical" in the abstract (no circuit breaker!) might be MEDIUM here because the load doesn't justify it; a finding that's "obscure" in the abstract (in-memory Map on serverless) is CRITICAL here because it actually fires at 10 users. The discipline is to rank by *who-feels-it-first* rather than by *book-says-it's-bad*. The lesson generalizes: every architecture review should produce a ranked, actionable list with the move named — not a list of theoretical risks the team is supposed to "be aware of." Being aware fixes nothing; the ranked fix-list is what gets executed.

---

## Primary diagram

The full audit as one matrix — what fires, what doesn't, severity for this codebase, and the move.

```
  Red-flag audit · 12 patterns · ranked by severity for THIS codebase

  ┌──────────────────────────────────────────────────────────────────────────┐
  │ # │ red flag                              │ here? │ sev │ effort │ when  │
  ├───┼──────────────────────────────────────┼───────┼─────┼────────┼──────┤
  │ 1 │ in-memory state in serverless         │ FIRES │ CRIT│ ~30 LOC│ ~10x │
  │ 2 │ retry budget vs route budget          │ FIRES │ HIGH│ ~50 LOC│ ~100x│
  │ 3 │ no observability on 300s ceiling      │ FIRES │ HIGH│ ~20 LOC│ first│
  │   │                                       │       │     │        │  prod│
  │   │                                       │       │     │        │  bug │
  │ 4 │ schema cache no TTL                   │ FIRES │ MED │ ~10 LOC│ rare │
  │ 5 │ fetch can't be cancelled              │ FIRES │ LOW │ ~15 LOC│ cost │
  │ 6 │ per-call retry budget (no global)     │ FIRES │ LOW │ subset │  see │
  │   │                                       │       │     │ of #2  │  #2  │
  │ 7 │ dev-only FS persistence fragile       │ FIRES │ LOW │ ~5 LOC │ rare │
  │ 8 │ distributed monolith                  │ NO    │ —   │ —      │  —   │
  │ 9 │ cargo-cult queues                     │ NO    │ —   │ —      │  —   │
  │ 10│ god object                            │ NO    │ —   │ —      │  —   │
  │ 11│ distributed transactions / saga       │ NO    │ —   │ —      │  —   │
  │ 12│ sticky sessions                       │ N/A   │ —   │ —      │  —   │
  └───┴──────────────────────────────────────┴───────┴─────┴────────┴──────┘

  Total fix budget if all FIRES are addressed: ~130 LOC.
  Highest-leverage single fix (Red Flag #1): ~30 LOC → eliminates race at 10x.
```

---

## Implementation in codebase

### The top-3 fix list, ordered by leverage

If you had one afternoon, this is what the audit recommends, in order.

#### Fix 1 — session-key the insights Map (~30 LOC)

**File:** `lib/state/insights.ts` + 3 call sites in `app/api/briefing/route.ts` (L243), `app/api/agent/route.ts` (L48), and the `listInsights` call in the briefing.

**Move:** Change `Map<string, Insight>` to `Map<string, Map<string, Insight>>` keyed by sessionId. Update `putInsights`, `getInsight`, `getAnomaly`, `listInsights` to take a sessionId parameter. The route already has `sessionId` via `getOrCreateSessionId` — thread it through.

**Why it's first:** It's the only fix that addresses a *correctness* issue (race), not just a scale concern. It fires at the smallest load (~10 concurrent users). The cost is small (no infra, no UX change). The impact is "the feed stops flickering and investigation 404s stop happening" — directly user-visible improvement.

#### Fix 2 — minimal observability on phase timings (~20 LOC)

**File:** `app/api/briefing/route.ts` and `app/api/agent/route.ts`, around each phase boundary.

**Move:** Add `const t0 = performance.now()` pairs around schema bootstrap, coverage gate, each agent run, and emit a structured log on `done`. The log shape: `{ route, phase, durationMs, sessionId, complete: boolean }`. Vercel's function logs already collect `console.log`, so no new infra. Aggregating these later (Datadog, OpenTelemetry) is the next move when traffic justifies it.

**Why it's second:** It doesn't fix anything by itself, but it makes Red Flag #3 visible the moment something breaks. Without it, the day a real production incident hits, you'll have no signal. *Add this before the first production traffic.*

#### Fix 3 — circuit breaker on McpClient (~50 LOC)

**File:** `lib/mcp/client.ts`.

**Move:** Add per-tool state: `consecutiveFailures: Map<string, number>`, `circuitOpenUntil: Map<string, number>`. After 5 consecutive 5xx-shaped responses, open the circuit for 30 seconds — every call during open returns a tagged error without going live. Close on first success after the open period.

**Why it's third:** Higher leverage than #4–7 (a Bloomreach outage at modest scale is a real production concern). Lower priority than #1 because it requires concurrency to manifest (today's traffic is too low to feel it).

### File index — every finding's anchor

| # | Red flag | File · Lines | Fix file |
|---|---|---|---|
| 1 | In-memory state race | `lib/state/insights.ts` L4, L30–L42 | same file + 3 call sites |
| 2 | Retry vs route budget | `lib/mcp/client.ts` L121–L132 + `app/api/agent/route.ts` L20 | `lib/mcp/client.ts` |
| 3 | No observability | `app/api/agent/route.ts` L20 + `app/api/briefing/route.ts` L17 | both route files |
| 4 | Schema cache no TTL | `lib/mcp/schema.ts` L131 | same file |
| 5 | Fetch can't be cancelled | `lib/hooks/useInvestigation.ts` L31–L36 (comment), L213 | same file + Next router events |
| 6 | Per-call retry budget | `lib/mcp/client.ts` L121–L132 (same lines as #2) | same as #2 fix |
| 7 | Dev FS persistence fragile | `lib/mcp/auth.ts` L137–L142 + `lib/state/investigations.ts` L33–L38 | both files |
| 8 | Distributed monolith | (DOESN'T FIRE — praise) | — |
| 9 | Cargo-cult queues | (DOESN'T FIRE — praise) | — |
| 10 | God object | (DOESN'T FIRE — praise) | — |
| 11 | Distributed transactions | (DOESN'T FIRE — praise) | — |
| 12 | Sticky sessions | (N/A) | — |

### Sample — the smallest possible Fix 1 sketch

```
  lib/state/insights.ts — proposed (after Fix 1)   ← annotated SKETCH

  const insights = new Map<string, Map<string, Insight>>();    ← per-session map
  const anomalies = new Map<string, Map<string, Anomaly>>();

  export function putInsights(items: Insight[], sessionId: string, rawAnomalies?: Anomaly[]): void {
    const sessMap = new Map<string, Insight>();
    const sessAnoms = new Map<string, Anomaly>();
    items.forEach((i, idx) => {
      sessMap.set(i.id, i);
      if (rawAnomalies?.[idx]) sessAnoms.set(i.id, rawAnomalies[idx]);
    });
    insights.set(sessionId, sessMap);          ← REPLACE this session's entry only
    anomalies.set(sessionId, sessAnoms);        ← no longer wipes other sessions
  }

  export function getInsight(id: string, sessionId: string): Insight | null {
    return insights.get(sessionId)?.get(id) ?? null;
  }
       │
       └─ ~30 LOC. The semantic change: "this user's freshest briefing
          replaces this user's stale one" stays correct; "user A's
          briefing wipes user B's data" stops being possible. The
          call sites need to pass sessionId — and they already have it
          (every route calls getOrCreateSessionId). The audit recommends
          this as the first move because it's CHEAP and ELIMINATES
          a correctness bug at the smallest scale (~10 users).
```

---

## Elaborate

### What this audit doesn't grade

- **Code-level smells** (god classes, long functions, primitive obsession). Those are owned by `study-software-design/08-red-flags-audit.md`.
- **Security smells** (CSRF, weak crypto, leaky logs). Those are owned by `study-security/08-security-red-flags-audit.md`.
- **Testing smells** (flaky tests, untested paths, mocks-as-validation). Those are owned by `study-testing/07-testing-red-flags-audit.md`.

This file is specifically system-design — *architectural* smells that would show up in a design review, not a code review.

### Why severity isn't textbook severity

The textbook would put "no circuit breaker" at the top of any review. For this codebase, it's #2 because the load doesn't justify it today. The textbook would barely mention "in-memory Map on serverless" because most serverless apps have a database. For this codebase it's #1 because we *don't* have a database and the Map IS the source of derived state. The discipline is to grade against THIS architecture's actual failure modes, not against an imagined system at imagined scale.

### What the praise rows are protecting

Each "doesn't fire" row names a discipline the next contributor could accidentally undo:

- **Distributed monolith** is protected by keeping the agent layer in-process (don't split into a separate service "for scaling").
- **Cargo-cult queues** is protected by keeping agent runs in-band (don't add a queue "for resilience").
- **God object** is protected by keeping the four agents as separate classes (don't merge into "one AgentRunner that does everything").
- **Distributed transactions** is protected by keeping the tool surface read-only (don't add write tools without re-evaluating the consistency model).

Naming these explicitly means the next contributor sees the choice as deliberate, not accidental.

### The architecture's overall grade

**Strong** at the lower bands (McpClient, runAgentLoop, the four agent classes, the NDJSON wire format, the schema-gate, the OAuth provider with PKCE+DCR). These are textbook implementations of patterns done correctly with anchors to real constraints (the 1 req/s rate limit, the 300s budget, the Vercel ephemeral instance model). **Weakest** in the state band — in-memory Map on serverless is the architecture's most fragile assumption, and Fix 1 directly addresses it. **Honest** about what it doesn't have (no database, no queue, no circuit breaker) — each absence is named with the criteria that would justify adding it.

---

## Interview defense

**What they are really asking:** can you grade your own architecture honestly, rank the fixes by leverage, and resist the urge to "fix" things that aren't actually broken?

---

**[mid] — What's the biggest system-design risk in blooming insights?**

The insights Map race at modest concurrency. `lib/state/insights.ts` holds one global Map per Vercel instance; `putInsights.clear()` is correct for one user (this run's insights replace last run's stale ones) but in a multi-user-on-one-instance world it wipes another user's data. Today it's invisible because traffic is tiny and Vercel routes most users to fresh instances. At ~10 concurrent users on the same warm instance it fires as feed flicker or investigation 404s. The fix is ~30 lines: key the Map by sessionId, take sessionId as a param in put/get/list. No infra change, no UX change. Highest leverage move in the codebase.

---

**[senior] — Rank the top three system-design fixes you'd make.**

Three, in order. **First**, session-key the insights Map — 30 LOC, fixes the race at 10x, the only correctness issue in the audit. **Second**, add minimal observability — 20 LOC, `console.log` with phase timings around each agent run, so when the 300s budget actually fires we can tell which phase ate the time. **Third**, circuit breaker on McpClient — 50 LOC, fail fast when Bloomreach is fully down instead of burning the full retry budget. Total ~100 LOC, no external services, eliminates the top three risks. I'd do Fix 1 before any production traffic, Fix 2 before the first production incident, and Fix 3 the first time real concurrency makes the retry budget visible.

```
  Fix priority — by leverage

  #1  insights Map race            ~30 LOC   correctness, ~10x trigger
  #2  observability on 300s        ~20 LOC   diagnostic, first incident
  #3  circuit breaker              ~50 LOC   scale, ~100x trigger
```

---

**[arch] — Defend NOT adding a database.**

Three reasons. **One**: the system-of-record is Bloomreach. Every fact a user sees originates there. Adding a database would mean choosing a freshness policy ("how stale can a cached insight be?") which is exactly the question this architecture punts on with "the briefing IS the current feed." **Two**: no multi-user durability requirement. There's no shared feed, no team workspaces, no "what did Alice see yesterday." Every browser is its own session; cookies + browser storage cover the durability we need. **Three**: ops cost. A database is a managed service to operate, migrate, back up, monitor. For ~5K LOC shipped by one person, the cost dominates. The architecture is honestly aligned with what it does today. The day product asks for history or shared feeds, I add Vercel KV (~$5/month, ~200 LOC) before reaching for Postgres. Postgres is correct for *enterprise* features (multi-tenant, audit, RBAC) — until those exist, it's cargo-culting database infrastructure.

---

**The dodge — "have you written a design review document?"**

No. This audit *is* the design review — it's organized as an audit checklist with each finding anchored to a file:line and a one-line fix. A traditional design doc would frame this as "the system today / problems we have / proposed changes / migration plan" — which is the same information in a different shape. For a real production deployment, I'd convert the top three fixes into RFCs (one per fix), each ~3 pages with the problem, the change, the rollout plan, and the rollback. The audit is the input to that; the RFC is the alignment artifact.

---

**One-line anchors:**
- 5 fires, 4 don't-fire (praise), 1 N/A; total fix budget ~130 LOC across the 5 fires.
- The single highest-leverage move is Fix 1 (session-key the insights Map, ~30 LOC) — eliminates the only correctness issue at the smallest scale.
- Rank by who-feels-it-first, not by book-says-it's-bad.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the top 3 fires in order of severity for this codebase. For each, name the file and the rough effort. Check against the file index.

### Level 2 — Explain
Why is "no circuit breaker" only #2 and not #1? Reference the difference between a correctness bug (Red Flag #1) and a scale concern (Red Flag #2).

### Level 3 — Apply
A teammate proposes adding "scheduled briefings" — every hour, re-run the monitoring agent for every session. Walk through which red flags this triggers, which fires harder under the new pattern, and what additional findings it would introduce. Reference files 03, 04, 06, 07.

### Level 4 — Defend
Defend the choice to keep "distributed monolith," "queues," and "god object" as DOESN'T FIRE rows in this audit — when does each become a real concern, and how would you know the day arrived?

### Quick check
- What's the #1 red flag? → in-memory state race (`lib/state/insights.ts` L4, L30–L42)
- What's the smallest fix in the entire audit? → Red Flag #7, ~5 LOC (`lib/mcp/auth.ts` + `lib/state/investigations.ts` warn on FS write failure)
- What's protected by the "no god object" praise? → keep the 4 agent classes separate; don't merge into a megaclass
- What's the total fix budget if all 5 fires are addressed? → ~130 LOC

---

## See also

→ [01-system-map-and-boundaries.md](./01-system-map-and-boundaries.md) · [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [06-failure-handling-and-reliability.md](./06-failure-handling-and-reliability.md) · [07-scale-bottlenecks-and-evolution.md](./07-scale-bottlenecks-and-evolution.md) · `study-software-design/08-red-flags-audit.md` (code-level smells, complementary to this file) · `study-security/08-security-red-flags-audit.md` (security smells) · `study-testing/07-testing-red-flags-audit.md` (testing smells)
