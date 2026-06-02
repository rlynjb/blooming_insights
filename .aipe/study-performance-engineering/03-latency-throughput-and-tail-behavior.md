# Latency, throughput, and tail behavior

**Industry name(s):** latency distribution · throughput · p95/p99 · tail amplification · serialized pipeline
**Type:** Industry standard · Language-agnostic

> A live blooming insights investigation runs **~100-115s** end-to-end (per the comment at `app/api/agent/route.ts:18-19`), and the latency is the **sum of three serialized waits**: ~6.6s of MCP spacing per agent (6 calls × `minIntervalMs = 1100`), ~3-10s of Anthropic latency per turn (up to 8 turns × 2 agents), and any rate-limit retry waits (up to 20s each, capped at 3 retries per call). **Throughput is one investigation at a time per user** — Bloomreach's ~1 req/s/user GLOBAL rate limit IS the throughput ceiling, and there's no batching anywhere. The tail (p99) is not measured, but the *shape* is knowable: it's whichever investigation hit rate-limit retries on multiple calls, and it can come within a hair of the 300s ceiling.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Latency is the *time to produce one answer*; throughput is *answers per unit time*. They usually trade off — you can lower latency by paralleling work (which raises throughput) or you can raise throughput by batching (which raises tail latency). blooming insights is the opposite of both: latency is bounded by *serialized* waits (1 in flight, ~1.1s apart), and throughput is bounded by *the same waits* (no parallelism, no batching). The reason isn't a code limit — it's Bloomreach's per-user rate cap, which says "1 in flight is the maximum allowed."

```
  Zoom out — where latency and throughput live          ← we are here (latency is sum across bands)

  ┌─ UI ─────────────────────────────────────────────┐
  │  Time-to-first-event ≈ 1-2s (streaming UI)        │
  │  Time-to-diagnosis ≈ 30-60s (depends on agent)    │
  │  Time-to-done ≈ 100-115s (typical investigation)  │
  └──────────────────────┬────────────────────────────┘
                         │ NDJSON chunks arrive line-by-line
  ┌─ Route ────────────▼──────────────────────────────┐
  │  Throughput: 1 stream per route invocation        │
  │  No queueing inside the route                     │
  │  REPLAY_DELAY_MS = 140/180 is paced (not latency) │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop ────────▼─────────────────────────────┐
  │  Per agent: maxToolCalls × (Anthropic + spacing)  │
  │  Anthropic latency per turn: ~3-10s observed      │
  │  Forced synthesis: +1 Anthropic call (output-heavy)│
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider/transport ─▼────────────────────────────┐
  │  Spacing floor: 1100ms between MCP calls           │
  │  Rate-limit retry: up to 20s per retry × 3 max     │
  │  Cache hit: 0ms (bypasses both spacing and network)│
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Bloomreach: ~1 req/s/user GLOBAL = THROUGHPUT CAP │
  │  Anthropic: per-call latency variance unmeasured   │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's the latency distribution for one investigation, where's the throughput ceiling, and what does the tail look like?* The answer for latency is *additive across serialized waits*; for throughput is *bounded by the rate limit, not by us*; for the tail is *bounded by the retry math, capped by the route ceiling*. Below, you'll see the latency math agent-by-agent, the throughput-by-design (no batching, no parallelism), and the tail's shape (the unmeasured p99 that can scrape against 300s).

---

## Structure pass

**Layers.** Five bands, each contributing wait time. The user sees the sum.

**Axis: latency contribution.** Hold one question constant across every band: *how much wall-clock time does this layer add to one investigation?* Latency contribution is the right axis because the whole user-visible experience is the *sum* of per-layer waits. Throughput sits sibling to latency (with no parallelism, throughput = 1 / latency); cost sits one file up (this file is *time*, file 01 is *bills*). Latency contribution lets you trace "where did the 100 seconds go?" with the answer changing at each band.

**Seams.** Three load-bearing.

- **L1: serial ↔ parallel.** Today, every wait is serial (one call in flight, agents run one after another). Crossing this seam — running diagnostic and recommendation in parallel after a diagnosis, or fanning out per-category checks — would lower latency but *break the rate limit* unless the spacing gate moves to a shared scheduler.
- **L2: typical ↔ tail.** Typical investigation: ~100-115s (the comment). Tail (p99): unknown but bounded by 300s. The retry math makes the tail amplification very visible — every rate-limit-retried call adds 10-20s on top of the typical wait.
- **L3: live ↔ replay.** Live mode pays Anthropic latency + MCP spacing. Demo replay pays only `REPLAY_DELAY_MS` (140ms briefing, 180ms agent). Same UI experience, ~100× latency difference. This is the seam that makes the demo *feel* like the system without paying the system's cost.

```
  Structure pass — Latency / throughput / tail

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider · External    │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  latency contribution: how much wall-clock        │
  │  does this layer add to one investigation?        │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  L1: serial ↔ parallel    (rate limit forbids)    │
  │  L2: typical ↔ tail       (retry math)            │
  │  L3: live ↔ replay        (same shape, 100× cost)★│
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the per-agent latency math, the throughput-by-design, and the tail's shape.

---

## How it works

### Move 1 — the mental model

You've watched `fetch()` waterfalls in Chrome's Network tab — three requests in a row (A → B → C), and the total time is the *sum* of the three, not the *max*. That's the shape of every blooming insights investigation. A diagnostic agent makes 4-6 tool calls; each call is `spacing + network + Anthropic-thinking`; each agent runs sequentially. The total is the sum. Parallelism would change the math (max of the three instead of the sum); blooming insights deliberately doesn't parallelize because the rate limit caps concurrent calls at 1.

```
  Pattern — latency as a sum of serialized waits

   ┌─ agent: diagnostic ─────────────────────────────┐
   │  call 1: spacing 1.1s + Anthropic 5s + tool 0.5s│ = 6.6s
   │  call 2: spacing 1.1s + Anthropic 4s + tool 0.5s│ = 5.6s
   │  call 3: spacing 1.1s + Anthropic 6s + tool 0.5s│ = 7.6s
   │  call 4: spacing 1.1s + Anthropic 3s + tool 0.5s│ = 4.6s
   │  call 5: spacing 1.1s + Anthropic 5s + tool 0.5s│ = 6.6s
   │  forced synthesis: Anthropic 8s (output-heavy)  │ = 8.0s
   └─────────────────────────────────────────────────┘ = 39s
                          │ (NDJSON: diagnosis emitted)
   ┌─ agent: recommendation ─────────────────────────┐
   │  call 1: spacing 1.1s + Anthropic 5s + tool 0.5s│ = 6.6s
   │  call 2: spacing 1.1s + Anthropic 4s + tool 0.5s│ = 5.6s
   │  forced synthesis: Anthropic 8s (output-heavy)  │ = 8.0s
   └─────────────────────────────────────────────────┘ = 20s

   total investigation: ~59-115s (matches the comment)
```

The model is: **total latency = sum of serialized waits across two agents**. There's no scaffolding to parallelize anything — agents run one after another (`app/api/agent/route.ts:237-249`), tool calls within an agent run one after another (the loop in `runAgentLoop`), and MCP calls between them are spaced by ~1.1s. The whole stack is single-flight by construction.

---

### Move 2 — the per-agent latency, the throughput, and the tail

#### Move 2.1 — per-call latency: floor + variance + retry

A single MCP tool call has three components: the spacing floor (deterministic), the network + server time (variable), and any rate-limit retry waits (rare but heavy).

```
  Pattern — per-call latency components (one MCP tool call)

   ─────────────────────────────────────────────────────────────
   FLOOR     (deterministic)      1100 ms - elapsed_since_last
                                   typically 0-1100 ms
   ─────────────────────────────────────────────────────────────
   NETWORK   (variable)            ~200-800 ms
                                   (HTTPS handshake re-used; just request)
   ─────────────────────────────────────────────────────────────
   SERVER    (variable)            ~200-2000 ms
                                   (Bloomreach EQL execution time)
   ─────────────────────────────────────────────────────────────
   RETRY     (rare, heavy)         0 ms typical
                                   up to 20_000 ms (retryCeilingMs)
                                   × up to 3 retries (maxRetries)
                                   = up to 60_000 ms in worst case
   ─────────────────────────────────────────────────────────────

   typical hit: ~1.5-3s per call
   slow call:   ~3-5s per call
   retried 1x:  ~13-23s per call
   retried 3x:  ~33-63s per call
   ⚠ retried 3x on a single call eats 1/5 of the route budget alone
```

The boundary: the spacing floor is *additive* with the rest. A fast Bloomreach response (200ms) still spends 1100ms in spacing — the floor wins. Only when the network + server time *exceeds* 1100ms does the spacing become invisible (the prior call's tail covered it).

#### Move 2.2 — per-agent latency: maxToolCalls × per-call + forced synthesis

An agent's latency is `(number of tool calls) × (per-call latency) + (Anthropic latency per turn) × (number of turns) + (possible forced synthesis call)`.

```
  Pattern — per-agent latency (one agent loop run)

   each turn:  Anthropic_thinking (3-10s)
                ├─ if model emits tool_use blocks:
                │    spacing + network + server (~1.5-3s per tool)
                │    feed results back as next user turn
                └─ if model emits text only (no tools):
                     turn is the final answer; loop exits

   if turns_used < maxToolCalls and model produces valid JSON:
     latency = sum(Anthropic_thinking) + sum(tool_call_latency)

   if turns_used == maxToolCalls (budget hit) OR maxTurns reached:
     latency = above + 1 × forced-synthesis Anthropic call (~5-10s)
                       (NO tools — output-only — output-token heavy)

   typical diagnostic agent (4-6 tool calls, completes cleanly):
     ~30-50s end-to-end

   typical diagnostic agent (hits budget, forces synthesis):
     ~40-60s end-to-end
```

The agent loop's structure (`lib/agents/base.ts:85-172`) makes this latency profile inevitable: each turn is one Anthropic round-trip plus per-tool MCP calls; no overlap between thinking and tool execution; the forced-synthesis turn is *another* full round-trip with no tools, just output.

#### Move 2.3 — total investigation: diagnostic + recommendation, serialized

The route handler runs the diagnostic agent, awaits its diagnosis, *then* runs the recommendation agent (`app/api/agent/route.ts:231-249`). No overlap — the recommendation needs the diagnosis as input.

```
  Pattern — total investigation latency (diagnose + recommend, serial)

   bootstrap (schema + listTools):  ~5-10s
                                     (4 MCP calls × ~1.5-2.5s each)
        │
        ▼
   diagnostic agent run:             ~30-50s typical
                                     ~50-80s if forced synthesis fires
        │
        ▼
   recommendation agent run:         ~20-35s typical
                                     ~30-50s if forced synthesis fires
        │
        ▼
   done event emitted, stream closes

   TOTAL TYPICAL:   ~60-100s  (matches the ~100-115s comment with some retry headroom)
   TOTAL WITH BAD LUCK (multiple retries):  150-280s, can scrape against 300s
   TOTAL WORST CASE (3 retries on 2 calls): exceeds 300s, route dies
```

The principle that pops out of the math: **the route budget (300s) is *exactly* enough for two agents under typical conditions but has almost no headroom for retry bursts.** This is what file 01's "pinned at the ceiling" finding meant in concrete numbers.

#### Move 2.4 — throughput: one investigation at a time per user

There is no batching, no parallelism, no queueing. One user can run one investigation at a time. The Bloomreach rate limit is *per user GLOBAL* — if user A and user B both run investigations, neither blocks the other (different rate-limit buckets). But within one user, throughput = `1 / latency` = `1 / ~100s` = `~0.01 investigations/second` = `~36 investigations/hour`.

```
  Pattern — throughput, per user

   one user, sequential investigations:
     ~0.01 inv/sec  =  36 inv/hour  =  ~864 inv/day (if zero downtime)

   one user, attempting parallel (would HIT the rate limit):
     → second concurrent call blocks at the spacing gate (in-process)
     → if process-level, the McpClient instance is shared by route
       handlers in the same Node process — calls queue in the gate
     → if cross-process (different Vercel instances), the SECOND
       call gets the 429 from Bloomreach itself, retries with 10s
       back-off, slows the burst

   N users, no shared state:
     N × ~0.01 inv/sec
     bounded by Anthropic's per-key rate limit (much higher; not hit yet)
```

The honest framing: blooming insights has *low throughput per user* by external constraint, and *no batching* to amortize that constraint. There's no place in the system that batches MCP calls (Bloomreach's MCP doesn't expose a batch endpoint), and there's no place that batches Anthropic calls (each agent's calls are sequential conversation turns; not batchable).

#### Move 2.5 — the tail: bounded by the retry math

The tail is the long-running investigation that nobody planned for. blooming insights' tail comes from rate-limit retries.

```
  Pattern — tail amplification

   typical call:        ~1.5-3s
   call with 1 retry:   ~13-23s  (retried call adds 10-20s wait)
   call with 2 retries: ~25-43s
   call with 3 retries: ~38-63s
   (3 is maxRetries cap — beyond it the call returns the error envelope)

   IF an investigation has N calls that each retry K times:
     extra latency = N × K × (10-20s)

   for the diagnostic agent (6 calls):
     1 call with 1 retry:    +10-20s extra   (~typical + 10-20s)
     3 calls with 1 retry:   +30-60s extra   (~typical + 30-60s)
     2 calls with 3 retries: +50-100s extra  (TYPICAL + 50-100s)

   ★ at the worst case (multiple calls × multiple retries), the
   total investigation latency exceeds 300s and the route dies.

   what bounds the tail:
     - maxRetries = 3 per call (lib/mcp/client.ts:121)
     - retryCeilingMs = 20_000 (per retry)
     - maxDuration = 300_000 (catches the cumulative overrun)
```

The principle: **the tail isn't unbounded — it's bounded by the route budget**. When the tail crosses 300s, the function dies and the user sees a half-stream. The retry math defines *where* the tail lives, but the route ceiling defines *whether* the user sees an answer at all.

---

### Move 3 — the principle

**Serialized waits add; they don't max.** This is the lesson the latency math exposes. A fetch waterfall in the browser adds; a parallel `Promise.all` takes the max. blooming insights is the fetch-waterfall shape because the rate limit forbids parallelism. Every optimization that targets latency has to either *shrink one wait* (faster Anthropic call, faster Bloomreach query) or *remove one wait entirely* (cache hit → 0ms; that's what the 60s TTL does). You can't optimize what the rate limit gives you — but you can avoid paying for it twice in the same investigation, which is exactly what the cache does.

---

## Primary diagram

The full latency picture — the layers, the per-call math, the per-agent math, the total, and the tail.

```
  blooming insights — the full latency landscape

  ┌─ User issues investigation ──────────────────────────────────────────┐
  │  click "investigate" on a feed insight                                │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  fetch /api/agent?insightId=…
                                 ▼
  ┌─ Route opens stream (immediate) ─────────────────────────────────────┐
  │  TTFE = ~100-500ms  (first reasoning_step event)                     │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  bootstrap schema (4 MCP calls)
                                 ▼  ~5-10s
  ┌─ Diagnostic agent runs ──────────────────────────────────────────────┐
  │  Turn 1: Anthropic (3-10s) → tool_use                                 │
  │       Tool 1 (spacing 1.1s + net+srv 0.5-2.5s)                        │
  │  Turn 2: feed result back → Anthropic (3-10s) → tool_use              │
  │       Tool 2 (spacing + net+srv)                                      │
  │  ... up to maxToolCalls=6 calls ...                                   │
  │  Final turn (or forced if budget hit):                                │
  │       Anthropic with NO tools → JSON output                           │
  │                                                                        │
  │  Per call:  ~1.5-3s (typical) / ~13-63s (with retries)                │
  │  Per agent: ~30-50s (typical) / ~50-80s (forced synthesis)            │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  diagnosis event emitted
                                 │  (UI updates the EvidencePanel)
                                 ▼
  ┌─ Recommendation agent runs ──────────────────────────────────────────┐
  │  Same shape, fewer calls (maxToolCalls=4)                             │
  │  Per agent: ~20-35s typical                                           │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  recommendation events emitted
                                 ▼
  ┌─ Stream closes (done event) ─────────────────────────────────────────┐
  │  TOTAL TYPICAL:  ~60-100s end-to-end                                  │
  │  TOTAL WITH 1 RETRY:  ~110-130s                                       │
  │  TOTAL WORST (multi-retry):  150-280s (scrapes route budget)          │
  │  ROUTE BUDGET:  300s   →   beyond this, Vercel kills the function     │
  └───────────────────────────────────────────────────────────────────────┘

  THROUGHPUT (per user):
    ~0.01 inv/sec  =  ~36 inv/hour  =  bounded by SERIAL execution
    Bloomreach: 1 req/s/user GLOBAL  (per-user buckets; N users don't contend)

  TAIL (p99):
    NOT MEASURED
    UPPER BOUND: 300s (route ceiling)
    SHAPE: dominated by rate-limit retry bursts
```

---

## Implementation in codebase

### Use cases — where latency math lives

- **The spacing floor** — every MCP call inside an agent loop. Without it, Bloomreach 429s; with it, ~1.1s minimum per call.
- **The retry wait** — when Bloomreach returns "rate limit reached (1 per 10 second)", `parseRetryAfterMs` extracts 10000 and `liveCall` sleeps it before retrying.
- **The forced-synthesis call** — when an agent hits `maxToolCalls`, one extra Anthropic call fires with no tools, adding ~5-10s.
- **The serial agent chain** — diagnostic must complete before recommendation begins, because recommendation needs the diagnosis as input.
- **The bootstrap chain** — `bootstrapSchema` (`lib/mcp/schema.ts:170`) calls four MCP tools sequentially before the first agent even starts; this is ~5-10s of the typical investigation.

### Code side by side

**The spacing gate — the per-call latency floor.**

```
  lib/mcp/client.ts  (lines 148–157)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;             ← time since last call ended
    if (elapsed < this.minIntervalMs) {                       ← under floor (1100ms)?
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  ← sleep diff
    }
    try {
      const result = await this.transport.callTool(name, args);  ← actual network call
      this.lastCallAt = Date.now();                              ← restart the clock
      return result;
    }
        │
        └─ this sleep is the LATENCY FLOOR. If elapsed=200ms, we sleep 900ms.
           If elapsed=2000ms (the prior call was slow), we sleep 0ms — the
           prior call's tail already paid the spacing cost.
           IMPORTANT: this is a single-flight gate. Two concurrent callTool
           invocations in the same process serialize through this gate by
           virtue of awaiting; the second one sees lastCallAt updated by
           the first one's completion. There's no semaphore — the sleep IS
           the gate.
```

**The retry wait — the source of tail amplification.**

```
  lib/mcp/client.ts  (lines 121–132)

  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {  ← maxRetries = 3
    retries++;
    const hintMs = parseRetryAfterMs(result);                    ← parse "per 10 second" → 10000
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);    ← fallback exponential
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,     ← prefer hint
      this.retryCeilingMs,                                       ← capped at 20000
    );
    await sleep(waitMs);                                         ← THE TAIL LIVES HERE
    result = await this.liveCall(name, args);                    ← retry
  }
        │
        └─ a single retry costs up to 20s. Three retries on one call costs
           up to 60s. If two calls in one investigation each retry once,
           that's +20-40s on top of the typical ~100s — comfortably under
           the 300s ceiling. But three retries on each of two calls is
           ~120s extra, which CAN cross the ceiling.
```

**The serial agent chain — diagnostic, await, then recommendation.**

```
  app/api/agent/route.ts  (lines 231–249)

  } else {                                                       ← step !== 'recommend'
    stepFor(
      'diagnostic',
      'thought',
      `investigating "${inv.metric}" (...)`,
    );
    const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
    diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));  ← AWAIT (~30-50s)
    send({ type: 'diagnosis', diagnosis });                      ← UI sees the result
  }

  if (step !== 'diagnose') {                                     ← only on combined or recommend
    stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
    const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
    const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
    for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
  }
        │
        └─ the second await blocks on the first. There's no `Promise.all`
           here because there can't be — recommendation needs the diagnosis
           as INPUT (passed as the third arg to propose()). The agents
           are CAUSALLY chained, not just sequenced.
```

**The bootstrap chain — four MCP calls serialized before the agent even starts.**

```
  lib/mcp/schema.ts  (lines 170–193)

  export async function bootstrapSchema(mcp: McpClient): Promise<WorkspaceSchema> {
    if (cached) return cached;                                   ← schema cache (file 06)
    const { projectId, projectName } = await resolveProject(mcp); ← 2 MCP calls (~3s)
    const args = { project_id: projectId };

    // Sequential — the server allows ~1 req/s; McpClient already spaces calls.
    const eventSchema = await callOrThrow(mcp, 'get_event_schema', args);          ← ~1.5-3s
    const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args); ← ~1.5-3s
    const catalogs = await callOrThrow(mcp, 'list_catalogs', args);                ← ~1.5-3s
    const overview = await callOrThrow(mcp, 'get_project_overview', args);          ← ~1.5-3s

    cached = parseWorkspaceSchema({...});
    return cached;
  }
        │
        └─ ~6 calls × ~1.5-3s = ~9-18s of bootstrap on a COLD cache.
           On a warm cache (the module-level `cached` is non-null), this
           returns in microseconds. The module-level cache is what makes
           the second investigation in a session faster than the first.
```

---

## Elaborate

**Where this pattern comes from.** Latency-as-sum-of-serialized-waits is the classic Amdahl's-law shape: the time to complete a job is bounded by the *sum* of its irreducibly serial parts. Network engineers know it as "RTT × number of round-trips" (which is why HTTP/2 multiplexing matters). Database engineers know it as "single-row latency × N for an unbatched ORM." For blooming insights, the serial parts are *external waits* — the rate limit and the model — which we can't parallelize without breaking the rate limit's contract.

**Why batching doesn't help here.** Batching amortizes the per-call overhead (TLS, request setup, model warmup) across multiple operations. Bloomreach's MCP doesn't expose a batch endpoint — each EQL query is one call. Anthropic's `messages` API doesn't batch (each call is a conversation turn). So even if we wanted to batch, neither external provider supports it. The closest thing is *prompt prefix caching* (which would let Anthropic skip re-tokenizing the system prompt across turns) — also absent today.

**Why the cache is the highest-leverage perf fix.** A cache hit returns in `durationMs: 0, fromCache: true` (`lib/mcp/client.ts:108`), bypassing *both* the spacing floor and the network entirely. On a warm cache, a call that would have cost 1.5-3s costs 0s. The 60s TTL is set such that repeated tool calls *within an investigation* hit the cache (Claude often re-derives the same EQL query when exploring a hypothesis). File 06 walks the cache mechanics in depth.

**Connection to adjacent concepts.** File 04 covers what happens to memory during these long-running agent loops (messages array growth). File 05 covers the I/O contributions to the latency (HTTPS round-trips, NDJSON streaming out). File 06 explains the cache that turns 1.5-3s into 0s. File 08 ranks the latency risks (the unmeasured tail being top-3).

---

## Interview defense

### Q: A typical blooming insights investigation takes ~100s. Walk me through where the time goes.

**Answer:** It's a sum of serialized waits across two agents. Bootstrap (schema + listTools) is 4 MCP calls × ~1.5-2.5s = ~5-10s. Diagnostic agent: 4-6 tool calls × ~1.5-3s each (spacing + network + EQL execution) + 4-6 Anthropic turns × ~3-10s = ~30-50s, plus a forced-synthesis call if the budget hits (+5-10s). Recommendation agent: 2-3 tool calls + 2-3 Anthropic turns = ~20-35s. The total is ~60-100s typical, matching the route comment. There's no parallelism — Bloomreach's ~1 req/s/user limit makes single-flight the only safe pattern.

```
  the ~100s math, decomposed

   bootstrap        ~5-10s    (4 MCP calls, before any agent)
   diagnostic       ~30-50s   (4-6 tool calls + Anthropic turns + maybe synthesis)
   recommendation   ~20-35s   (2-3 tool calls + Anthropic turns + maybe synthesis)
   ──────────────────────
   total            ~55-95s   typical
                    +10-50s   if any rate-limit retries fire
                    can hit 280-300s in worst-case retry storms
```

### Q: What's the tail look like, and what bounds it?

**Answer:** The tail isn't measured (no p99 anywhere), but its shape is knowable from the retry math. Each rate-limit retry adds up to 20s (`retryCeilingMs`), capped at 3 retries per call (`maxRetries`). The diagnostic agent makes 6 calls. The bad-day investigation has multiple calls retrying: 2 calls × 1 retry adds ~20-40s; 2 calls × 3 retries adds ~80-120s. The route budget (300s) is the upper bound — beyond that, Vercel kills the function and the user sees a stream cut mid-event. The data-quality note in the UI (`app/investigate/[id]/page.tsx:152-173`) counts errors *within* a run but never aggregates across runs.

```
  the tail's shape

   typical:               ~60-100s
   1 call × 1 retry:      +10-20s
   3 calls × 1 retry:     +30-60s
   2 calls × 3 retries:   +80-120s   ← scrapes 280s, near ceiling
   ROUTE BUDGET 300s      ← Vercel kills beyond this
```

### Q: Why is throughput so low and why doesn't batching help?

**Answer:** Throughput is `1 / latency` because everything is serialized. Per user it's about 0.01 investigations/second (~36/hour). Two reasons batching doesn't help: Bloomreach's MCP doesn't expose a batch endpoint (each EQL call is one round-trip), and Anthropic's `messages` API doesn't batch (each call is a conversation turn). The Bloomreach rate limit is per-user GLOBAL, so N users don't contend with each other — but each individual user is bottlenecked by the same single-flight pattern. The only way to raise per-user throughput is the cache (a hit costs 0ms, bypassing both spacing and network) or breaking the agent run out of the route into a queue + worker (lifts the 300s budget; requires a database we don't have).

---

## Validate

**Level 1 — Reconstruct.** State the typical-investigation latency math: how many calls, how much per call, how it sums. (Answer: bootstrap = 4-6 MCP calls × ~1.5-2.5s = ~5-10s. Diagnostic = 4-6 tool calls × (1.1s spacing + ~0.5-2.5s network + ~3-10s Anthropic per turn) + optional forced synthesis = ~30-50s. Recommendation = 2-3 calls × same structure = ~20-35s. Total ~55-95s typical.)

**Level 2 — Explain.** Why is throughput bounded by `1 / latency` instead of "concurrent in-flight requests"? (Answer: blooming insights is single-flight by construction. The spacing gate in `McpClient.liveCall` is in-process — any concurrent callers serialize through the `await new Promise(setTimeout)`. The agent loop is sequential (one tool at a time, one turn at a time). The route runs one agent then the next. There's no fan-out and no queue. So per-user throughput is exactly `1 / one-investigation-latency`.)

**Level 3 — Apply.** A 60s TTL cache hit costs 0ms vs a miss costing 1.5-3s. If 2 of 6 diagnostic tool calls hit cache (because the agent re-derived the same EQL query), what does that save on a typical investigation? (Answer: ~3-6s saved on the diagnostic agent alone. The savings come from *both* skipping the spacing gate *and* skipping the network — a cache hit returns instantly. On a typical ~100s investigation, that's a ~3-6% speedup from one cache feature. The cache's leverage scales with how often the agent revisits the same query — see file 06 for the design choice that made 60s the TTL.)

**Level 4 — Defend.** A reviewer says "the spacing gate is killing latency — remove it." Defend or change. (Answer: remove the gate and Bloomreach returns 429 on the second call; we then pay the retry wait (10-20s) per failed call. The gate's 1.1s sleep is the *cheapest* compliance with the rate limit — every alternative is worse. The real lever for latency isn't removing the gate, it's *avoiding the gate*: cache hits (zero) and prompt prefix caching on Anthropic (would skip re-tokenization on every turn — currently absent, see `study-ai-engineering/06/01`). The gate is doing the right job; the question is whether we can get below the gate by not needing the call at all.)

---

## See also

- `01-performance-budget.md` — the 300s ceiling that catches the tail
- `02-measurement-baselines-and-profiling.md` — the histograms we'd need to actually know p95/p99
- `04-cpu-memory-and-allocation.md` — what messages-array growth does to the long-running loop
- `05-io-network-and-database-bottlenecks.md` — the network contribution to per-call latency
- `06-caching-batching-and-backpressure.md` — the cache that turns 1.5-3s into 0s
- `08-performance-red-flags-audit.md` — the unmeasured tail as a top-3 finding
- `.aipe/study-system-design/01-system-design/07-scale-bottlenecks-and-evolution.md` — what changes at 100x users
