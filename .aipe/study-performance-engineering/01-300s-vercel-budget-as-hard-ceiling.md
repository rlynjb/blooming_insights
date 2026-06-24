# 300s Vercel budget as hard ceiling

**Industry name(s):** route-duration budget · serverless wall-clock ceiling · hard latency budget · pinned-at-the-ceiling
**Type:** Project-specific (Vercel-specific shape) · Industry standard (the pattern)

> The single biggest number in blooming insights' performance contract is `maxDuration = 300` (in seconds) at `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17`. It is pinned **exactly at Vercel Pro's ceiling** — there is no engineering headroom between "the budget" and "what the platform allows." A typical investigation runs ~100-115s (per the comment at `app/api/agent/route.ts:18-19`); a bad-day investigation with multiple rate-limit retries can scrape against 280-300s. Beyond 300s, Vercel kills the function and the user sees a half-stream with no diagnosis. Everything else in this guide — the per-agent tool-call cap, the spacing gate, the 60s TTL cache — exists to fit *underneath* this ceiling.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Every serverless function has a wall-clock ceiling enforced by the platform. Vercel Pro's is 300 seconds; Hobby's is 60. You can configure `maxDuration` per route to any value at or below the platform's max — and the route's worst-case runtime must fit. This is a *hard* budget: it's not a soft SLO that emits a warning; it's the platform pulling the plug. The choice you make is whether to pin at the ceiling (zero headroom) or set it lower (catch overruns earlier with explicit error handling). blooming insights pins at the ceiling because the typical workload (~100-115s) and the constraints (~1 req/s Bloomreach, Anthropic latency variance) need every available second.

```
  Zoom out — where the 300s budget lives

  ┌─ UI ───────────────────────────────────────────────┐
  │  fetch /api/agent or /api/briefing                  │
  │  ReadableStream reader (NDJSON chunks)              │
  └────────────────────────┬────────────────────────────┘
                           │ HTTPS / chunked stream
  ┌─ Vercel platform ──────▼────────────────────────────┐
  │  serverless function instance                       │
  │  ★ wall-clock kill at maxDuration ★                 │  ← we are here
  │  Pro: 300s max · Hobby: 60s max                     │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Route handler ────────▼────────────────────────────┐
  │  export const maxDuration = 300;                    │
  │  ReadableStream that drives the agent run           │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Agent loop ───────────▼────────────────────────────┐
  │  bootstrap (5-10s) + diagnostic (30-50s) +          │
  │  recommendation (20-35s) + retry headroom (?)       │
  └─────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's the cost of pinning a hard budget at the ceiling, and what bounds the worst case?* The answer is *zero headroom on bad days, with the failure mode being "function killed mid-stream" — and the worst case is bounded by the sum of all serialized waits inside the route, with the rate-limit-retry math being the heaviest tail contributor.* Below, you'll see the budget composition (how nested budgets fit under the ceiling), the failure mode (what the user sees when the ceiling is hit), and the architectural moves that would lift the ceiling.

---

## Structure pass

**Layers.** Three nested layers bear the budget. The Vercel platform sets the *physical* ceiling. The route handler sets the *configured* ceiling via `maxDuration`. The agent loop runs *underneath* both, ignorant of either — it only knows about its own per-call constraints.

**Axis: failure containment.** Hold one question across the layers: *when this budget is exceeded, what kills the work, where does the user find out, and is the failure recoverable?* Failure is the right axis because a hard budget is fundamentally about *what happens when you miss it*. Cost (soft latency) and visibility (measurement) sit at different altitudes; for this pattern, the question is "who pulls the plug, and when."

**Seams.** Two load-bearing.

- **B1: configured ↔ enforced.** `maxDuration = 300` is the *configured* budget; Vercel's `300s max on Pro` is the *enforced* ceiling. Crossing this seam (raising `maxDuration` beyond the plan's max) silently does nothing; lowering it (e.g. to 250) gives engineering headroom but cuts into the typical workload's slack. The fact that the two values are *equal* in this codebase is the load-bearing fact.
- **B2: route-bounded ↔ run-bounded.** Today, the agent run is bounded *by the route* — the function and the work share a lifecycle. Crossing this seam (queue + worker) would put the agent run on a different lifecycle from the route's HTTP response, removing the 300s ceiling but requiring durability infrastructure (a database, a queue, a worker process) that doesn't exist.

```
  Structure pass — 300s Vercel budget

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Platform · Route handler · Agent loop            │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  failure containment: when budget exceeded,       │
  │  who kills, where does user find out?             │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  B1: configured ↔ enforced  (300 = 300)           │
  │  B2: route-bounded ↔ run-bounded  ★ load-bearing  │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the budget composition, the failure mode, and the path to lifting the ceiling.

---

## How it works

### Move 1 — the mental model

You've shipped a Lambda or a Cloud Run service before — same picture. Every serverless function has a wall-clock max; the platform enforces it; your code has to fit underneath. The unfamiliar bit is what happens when you *pin* your budget at the platform max: every nested cost inside the function (every per-call latency, every retry wait, every model round-trip) has to fit under that single ceiling, and the ceiling does not move. The composition is what makes pinning hard — you don't get to control any one cost; you control the *count* (`maxToolCalls`), the *floor* (`minIntervalMs`), and the *retry budget* (`maxRetries × retryCeilingMs`), and the sum has to fit.

```
  Pattern — budgets compose downward, each fits under the next

  external ceiling     Vercel Pro: 300s
        │
        ▼
  configured budget    maxDuration = 300         ← pinned at ceiling, NO headroom
        │
        ▼
  per-agent cap        maxToolCalls = 6 (diag) or 4 (rec)
        │
        ▼
  per-call floor       minIntervalMs = 1100
        │
        ▼
  per-retry ceiling    retryCeilingMs = 20_000 × maxRetries = 3

  the sum of (count × per-call cost) + (retry × per-retry ceiling)
  must be ≤ 300s — or Vercel kills the function
```

The model is: **the route budget is the catch-all; everything else exists to fit underneath**. You can't tighten Vercel's ceiling (it's the plan max). You *can* tighten what runs underneath — fewer tool calls per agent, shorter retry ceilings, tighter context caps. But every tightening trades off against the *typical* workload's needs.

---

### Move 2 — the budget composition, the failure mode, and the path to lifting it

#### Move 2.1 — the budget composition (how the math fits)

Open the comment at `app/api/agent/route.ts:18-19`: the rationale is named in code. Walk through the math one layer at a time.

```
  Pattern — typical investigation, fitting under 300s

  bootstrap chain (4-6 MCP calls, serial, no parallel allowed by rate limit)
       │   spacing floor: 4-6 × ~1.1s = 4.4-6.6s
       │   network + EQL: 4-6 × ~0.5-2.5s = 2-15s
       └── total: ~6-22s typical (~5-10s common)
                │
                ▼
  diagnostic agent (up to 6 tool calls + Anthropic turns)
       │   per turn: Anthropic 3-10s + spacing 1.1s + tool 0.5-2.5s
       │   forced synthesis (if maxToolCalls hit): +5-10s
       └── total: ~30-50s typical
                │
                ▼
  recommendation agent (up to 4 tool calls + Anthropic turns)
       │   same per-turn shape, fewer calls
       │   forced synthesis possible: +5-10s
       └── total: ~20-35s typical
                │
                ▼
  TOTAL TYPICAL: ~55-100s
  HEADROOM: ~200-245s on a typical day
```

The boundary: the typical case has comfortable headroom. The problem is the *tail*. Each rate-limit retry adds up to 20s (`retryCeilingMs`, `lib/mcp/client.ts:121-132`); `maxRetries = 3` per call; ~10-15 MCP calls per investigation. The bad-day arithmetic:

```
  Pattern — bad-day investigation, the headroom shrinks

   2 calls × 3 retries × 20s = +120s on top of typical
                │
                ▼
   TOTAL WITH RETRIES: ~175-220s typical case + retry burst
   HEADROOM: ~80-125s

   3 calls × 3 retries × 20s = +180s
                │
                ▼
   TOTAL WORST CASE: ~235-280s
   HEADROOM: ~20-65s — DANGEROUS

   beyond 300s: Vercel pulls the plug
   user sees: half-stream, no diagnosis
```

The tail is bounded — but the bound is the ceiling itself. The retry math says the worst case *can* exceed 300s; today, no measurement says how often it does.

#### Move 2.2 — the failure mode (what the user sees)

When the function is killed mid-stream, the client experiences a sudden close on the `ReadableStream`. The browser-side reader in `useInvestigation` (`lib/hooks/useInvestigation.ts:184-208`) reads a final partial chunk, then sees `done: true` without ever receiving the `{ type: 'done' }` sentinel.

```
  Pattern — the failure mode at the ceiling

   user POSTs /api/agent
        │
        ▼
   stream opens, first events arrive: reasoning_step, tool_call_start, ...
        │
        ▼
   ~30-60s: diagnosis event arrives, UI renders evidence panel
        │
        ▼
   recommendation agent starts; rate-limit retry storm fires
        │
        ▼
   ~280s: tool_call_start fires; tool_call_end never arrives
        │
        ▼
   ~300s: Vercel kills the function
        │
        ▼
   client reader: done: true, no { type: 'done' } event
        │
        ▼
   useInvestigation: complete state never flips true
        │  recommendation panel stays in skeleton
        │  ProcessStepper stays in 'active' on recommendation
        │  StatusLog shows last running tool with no duration
        └─ user sees: page looks like it's still working but isn't

   server-side: Vercel function logs show timeout error
   no console.error from our code (the function got killed, not crashed)
```

The boundary: this is *silent* from the application's perspective. There's no `try { ... } catch { send({ type: 'error' }) }` that handles "we ran over budget" because the function got killed *during* an `await`. The fix would be a watchdog timer that fires at, say, 270s and sends a graceful error event before Vercel kills — but that lives in the route, and the route doesn't currently have one.

#### Move 2.3 — the path to lifting the ceiling

There are only two ways out: lower the configured budget (catch overruns earlier with explicit handling), or change the architecture so the agent run is no longer bound by the route's lifecycle.

```
  Pattern — three architectural moves (lifting vs respecting the ceiling)

  ─── MOVE A: tighter inner budgets ───────────────────────────
   what:    maxToolCalls 6 → 4 (diagnostic), 4 → 3 (recommendation)
            retryCeilingMs 20_000 → 10_000
            maxRetries 3 → 2
   effect:  worst-case investigation shrinks (~280s → ~200s)
   cost:    less exploration → lower-confidence diagnoses
            less retry resilience → more user-visible errors
   trade:   trade quality for budget headroom
   ────────────────────────────────────────────────────────────

  ─── MOVE B: watchdog + graceful failure ─────────────────────
   what:    setTimeout at 270s → emit { type: 'error', code: 'budget' }
            close the stream before Vercel does
   effect:  failure becomes visible (user sees "timed out" not silence)
   cost:    ~10-30 lines in each route; no new infrastructure
   trade:   doesn't change WHEN failure happens, only HOW user sees it
   ────────────────────────────────────────────────────────────

  ─── MOVE C: queue + worker (break the route lifecycle) ──────
   what:    route enqueues the investigation; returns immediately
            worker process runs the agent (no 300s limit)
            UI polls / subscribes for results
   effect:  removes the 300s ceiling entirely
   cost:    REQUIRES a database (for queue + results)
            REQUIRES a worker process (a second deployment unit)
            REQUIRES auth/state propagation across the boundary
   trade:   architectural rework for a budget that bites rarely
   ────────────────────────────────────────────────────────────
```

The principle that pops out: **the ceiling is a constraint, not a goal**. Today, blooming insights pins at it because the typical workload needs the room. The right move *today* is Move A or Move B (small cost, real headroom). Move C is the right move *at scale* — when the rate of bad-day investigations is measured (R2's meter would tell us), and when a database is being added for other reasons.

---

### Move 3 — the principle

**Hard budgets are enforced by the layer above; soft budgets need a meter.** The 300s ceiling works because Vercel enforces it for free — we don't have to count milliseconds. The cost of pinning at the ceiling is that we get *no early warning* — there's no "you spent 250s, time to wind down" signal. A soft budget at, say, 270s (Move B above) would give us that signal at the price of writing a watchdog. The general lesson: **every hard budget should be paired with a soft budget below it, so the user sees a graceful error before the platform pulls the plug.** blooming insights has the hard budget; the soft one isn't built yet.

---

## Primary diagram

The full picture — the platform ceiling, the configured budget, the agent run underneath, the failure mode.

```
  blooming insights — the 300s budget at a glance

  ┌─ Vercel platform ─────────────────────────────────────────────────┐
  │                                                                    │
  │  Pro plan: maxDuration cap = 300s                                  │
  │  Hobby plan: maxDuration cap = 60s                                 │
  │  enforcement: wall-clock kill at the configured maxDuration       │
  │  ★ no graceful signal — the function just stops ★                  │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │
  ┌─ Route handler (configured) ───▼───────────────────────────────────┐
  │                                                                    │
  │  app/api/agent/route.ts:20:    export const maxDuration = 300;     │
  │  app/api/briefing/route.ts:17: export const maxDuration = 300;     │
  │  // comment names the rationale: ~100-115s typical, 60s won't fit  │
  │                                                                    │
  │  ★ pinned AT the platform ceiling — zero engineering headroom      │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │
  ┌─ Agent run (must fit under) ───▼───────────────────────────────────┐
  │                                                                    │
  │  bootstrap            ~5-10s     (4-6 MCP calls, serial)           │
  │  diagnostic agent    ~30-50s     (6 tool calls × ~1.5-3s + Anth)  │
  │  recommendation     ~20-35s     (4 tool calls × ~1.5-3s + Anth)  │
  │  ─────────────────────────────                                      │
  │  TYPICAL TOTAL       ~55-95s     (~205-245s headroom)              │
  │                                                                    │
  │  bad-day adders:                                                   │
  │   1 retry storm:     +20-60s     (~280s — TIGHT)                   │
  │   2 retry storms:    +60-120s    (~215-275s — DANGEROUS)           │
  │   3 retry storms:    +120-180s   (~275-300s — HITS CEILING)        │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │
  ┌─ Failure mode (when ceiling hit) ─▼────────────────────────────────┐
  │                                                                    │
  │  Vercel: function killed (no graceful close)                       │
  │  Client: ReadableStream ends without `{ type: 'done' }`            │
  │  UI: ProcessStepper stuck in 'active'; recommendation never shows  │
  │  Logs: timeout error in Vercel function logs; no app-side log      │
  │  ★ NO measurement today of how often this fires ★                  │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where the 300s budget is reached for

- **Both NDJSON-streaming routes.** `app/api/agent/route.ts` runs the diagnostic + recommendation chain; `app/api/briefing/route.ts` runs the monitoring scan. Both can take 100+ seconds in live mode, both are pinned at 300s.
- **The briefing route's `?demo=cached` path** — bypasses the agents entirely and replays committed JSON paced by `REPLAY_DELAY_MS = 140`. The 300s budget isn't even close to being a constraint here (~30-50s for a full replay), but the budget stays the same for code-uniformity reasons.
- **Failure mode in production** — when the budget is hit, only Vercel's function logs show the timeout. The application-side code emits nothing (no `console.error`, no event) because the kill happens during an `await` with no rescue path.

### Code side by side

**The budget itself, with the rationale comment that names the constraint.**

```
  app/api/agent/route.ts  (lines 18–20)

  // 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)  ← the rationale, in code
  // runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.       ← judgment, not measurement
  export const maxDuration = 300;                                                  ← the budget, pinned at ceiling
        │
        └─ removing this line drops the route to Vercel's default (60s on Hobby,
           higher on Pro). The investigation would die mid-recommend almost
           every time. This is the LOAD-BEARING line for the whole system —
           every other budget in the codebase exists to fit underneath it.
```

**The retry waits that produce the bad-day tail.**

```
  lib/mcp/client.ts  (lines 121–132)

  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {  ← maxRetries = 3
    retries++;
    const hintMs = parseRetryAfterMs(result);                    ← parse "per 10 second" → 10000
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);    ← fallback exponential
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,     ← prefer the server's hint
      this.retryCeilingMs,                                       ← capped at 20000
    );
    await sleep(waitMs);                                         ← THIS IS WHERE TAIL LIVES
    result = await this.liveCall(name, args);                    ← retry
  }
        │
        └─ a single retry on one call: up to 20s.
           three retries on one call: up to 60s.
           three retries on three calls: up to 180s — easily crosses ceiling.
           the maxRetries × retryCeilingMs × per-investigation-call-count
           is the tail math that decides whether the 300s budget holds.
```

**The agent loop's hard stop — what triggers the bounded inner budgets.**

```
  lib/agents/base.ts  (lines 88–101)

  // Omit tools when the model must now produce a final answer instead of
  // another tool call — guarantees a non-empty response and bounds latency:
  //   - on the final allowed turn, or
  //   - once the hard tool-call budget (maxToolCalls) is reached.
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;                              ← inner budget trip
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
  };
  if (!forceFinal) params.tools = toolSchemas;                                          ← drop tools to force synthesis
        │
        └─ the inner budgets (maxToolCalls, maxTurns) bound the agent run
           BEFORE the 300s ceiling can fire. Without these, an unbounded
           model might keep "wanting to query" until the function dies.
           These caps are what make 300s achievable for the typical case —
           they're the layered budgets that compose under the ceiling.
```

**Where the watchdog would live (Move B above — currently absent).**

```
  // ── PROPOSED FIX (Move B — illustrative, not yet applied) ──
  //
  // app/api/agent/route.ts (inside the stream's start function):
  //
  //   const watchdog = setTimeout(() => {
  //     send({ type: 'error', code: 'budget_exceeded', message: '...' });
  //     controller.close();
  //   }, 270_000);  ← 30s before Vercel's kill
  //
  //   try { ... agent run ... } finally { clearTimeout(watchdog); }
  //
  // ~10 lines per route. Transforms the failure from silent to visible.
```

---

## Elaborate

**Where this pattern comes from.** Serverless wall-clock budgets are a feature of every FaaS platform — AWS Lambda (15 min max), Cloud Functions (60 min on 2nd gen), Vercel (60s Hobby, 300s Pro, 900s Enterprise). The shape is identical across providers: configure your max, the platform enforces it. The optimization pattern is the same too: fit the typical workload under the budget, then add a watchdog below it for graceful failure. The anti-pattern is pinning at the ceiling with no watchdog — which is exactly what blooming insights does today.

**Why pinning at the ceiling is defensible (and where it breaks).** It's defensible when (a) the typical workload genuinely uses most of the budget, (b) the tail is bounded by other means (the retry math is capped at `maxRetries × retryCeilingMs`), and (c) the failure mode of hitting the ceiling is recoverable for the user (they can retry). All three hold for blooming insights today. It breaks when (a) the typical workload grows (e.g. a third agent gets added), (b) the tail becomes unbounded (e.g. a flaky external dependency causes more retries), or (c) the user can't easily retry (e.g. the system charges for failed investigations). Today, none of those have happened — but the second one (tail unboundedness) is what the lack of measurement (R2) hides.

**Why Move C (queue + worker) is the right move at scale, not today.** Adding a queue + worker fundamentally separates the agent run's lifecycle from the HTTP request's. The route returns immediately with an investigation ID; the worker runs to completion (no 300s ceiling); the UI polls or subscribes via Server-Sent Events / WebSocket. The cost is infrastructure: a database (to store queue + results), a worker deployment (a second runtime unit), auth propagation (the worker needs the user's MCP token). At demo scale, all three are expensive overhead. At production scale (paying customers, hundreds of investigations/day), all three become inevitable for other reasons (durability, cost tracking, user history). The right time to make Move C is when one of those other reasons forces a database to exist — then the queue + worker is a small additional cost on top.

**Connection to adjacent concepts.** `study-system-design/audit.md#scale-bottlenecks-and-evolution` covers Move C as the second scale ceiling. `study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` covers what changes if the agent run topology fans out. This file's load-bearing fact (pinned at ceiling, zero headroom) is what makes both adjacent files relevant: if either ever shifts, the 300s budget shifts with them.

---

## Interview defense

### Q: Why is `maxDuration` pinned at 300 specifically, and what's the cost of that choice?

**Answer:** It's pinned at Vercel Pro's *maximum* — not at a number we measured. The comment at `app/api/agent/route.ts:18-19` names the rationale: a live investigation runs ~100-115s typical, and 60s (Hobby tier) can't fit it. So 300s is the smallest number on Vercel that does. The cost of pinning *at* the ceiling is zero engineering headroom — if Bloomreach has a bad day and the rate-limit retries pile up, the cumulative time can scrape against 300s, and there's no "graceful warning" because Vercel just kills the function. The right pair would be a watchdog at ~270s that emits a graceful error event before the platform pulls the plug — that's not built yet.

```
  the 300s budget — defended

   why 300: Vercel Pro's max; smaller wouldn't fit ~100-115s typical
   what it costs: zero headroom on bad days
   what's missing: a watchdog timer (~270s) for graceful failure
   what would lift it: queue + worker (Move C — requires DB)
```

### Q: What's the worst-case investigation latency, and is it bounded?

**Answer:** It *is* bounded — by the retry math + the ceiling. Each rate-limit retry costs up to 20s (`retryCeilingMs` at `lib/mcp/client.ts:121-132`), capped at `maxRetries = 3` per call. With ~10-15 MCP calls per investigation, the worst case is ~120-180s of retry-only latency on top of the typical ~100s — total ~220-280s, scraping the ceiling. Beyond 300s, the function dies. The bound is the ceiling itself; the *measurement* of how often we approach it is missing (R2 — no per-investigation duration histogram). I'd add that meter before anything else here.

```
  worst-case math

   typical:               ~100-115s
   bad-day (1-2 retries): +20-60s   → ~150s
   worst (3+ retries):    +120-180s → ~280s — scrapes ceiling
   beyond:                Vercel kills, user sees half-stream
```

### Q: A new agent is being added that runs after recommendation — what does that do to the 300s budget?

**Answer:** It eats the headroom. The typical case grows from ~55-95s to ~85-145s (a third agent adds ~30-50s). The bad-day case shifts from ~280s (already tight) to ~310-330s (over the ceiling on a retry storm). Before shipping the new agent, two things have to land: (a) Move A — tighten `maxToolCalls` (5 → 4 across diagnostic / new-agent / recommendation) so the typical case stays under ~120s, or (b) Move B — the watchdog timer, so the bad-day failure becomes visible instead of silent. Ideally both. If neither, the new agent ships with a known bad-day failure rate that no one can measure.

---

---

## See also

- `audit.md` — the lens-level findings, including this pattern's place in the ranked risks
- `02-ttl-cache-with-no-cache-on-error.md` — the cache that returns ~1.5-3s per hit to the budget
- `03-spacing-gate-as-rate-limit-compliance.md` — the 1.1s floor that makes the budget tight
- `04-synthesize-as-cost-concentration.md` — the unmeasured cost line that may amplify bad-day latency
- `.aipe/study-system-design/audit.md#scale-bottlenecks-and-evolution` — Move C (queue + worker) at scale
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — what changes if the agent run fans out
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
