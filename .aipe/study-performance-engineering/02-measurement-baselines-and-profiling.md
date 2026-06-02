# Measurement, baselines, and profiling

**Industry name(s):** observability for performance · baseline + before/after · profiling · the meter
**Type:** Industry standard · Language-agnostic

> blooming insights measures **one number** today — per-tool-call duration, emitted as `tool_call_end.durationMs` on the NDJSON event stream (`lib/mcp/events.ts:7`, written at `lib/agents/base.ts:149`) — and that's it. No p50/p95/p99 aggregation, no per-investigation total, no `res.usage` logging on any Anthropic call, no profiler integration, no load-test harness, no synthetic baseline. The one number it does emit is *displayed* in the UI's status panel (`StatusLog` component) but *never persisted* — every refresh wipes the history. A baseline ("a typical investigation takes 100-115s") exists only as a *comment* in `app/api/agent/route.ts:18-19`, not as a measurement anyone reruns.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Performance work has a strict ordering: *baseline → measurement → diagnosis → fix → re-measure*. Skip the baseline and you can't tell if your fix helped. Skip the measurement and you're tuning on hope. Skip the profiler and you guess at which line is slow. blooming insights ships the *fix-shaped* pieces (cache, spacing, truncation, forced synthesis) but not the *measure-shaped* pieces — so the fixes are working, the budgets are holding, and nobody can prove either. This file is about the meter that isn't there.

```
  Zoom out — what we measure, what we don't          ← we are here (every band, mostly absent)

  ┌─ UI ─────────────────────────────────────────────┐
  │  no Web Vitals, no LCP/INP/CLS                    │
  │  no client-side perf marks                        │
  │  no React Profiler integration                    │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Route ────────────▼──────────────────────────────┐
  │  no per-investigation duration metric             │
  │  no error-rate counter                            │
  │  console.error on failure only (Vercel logs)      │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop ────────▼─────────────────────────────┐
  │  ★ NO res.usage logging — token cost invisible ★   │
  │  no per-agent latency aggregation                 │
  │  the synthesize() call's frequency is unknown     │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider/transport ─▼────────────────────────────┐
  │  ★ tool_call_end.durationMs — the one meter ★      │
  │  emitted per call, displayed in UI, not persisted │
  │  fromCache boolean is captured but not aggregated │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Anthropic returns res.usage — we never read it   │
  │  Bloomreach returns no perf metadata              │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what would we need to measure for each soft budget in file 01 to become a real contract, where is the closest existing surface in the code, and what's the cheapest way to add it?* Below, you'll see the one meter we have, the meters we don't, the baseline that exists as a comment instead of a number, and the cheap fixes that would change that.

---

## Structure pass

**Layers.** The same five bands. Each layer either has a meter (one does), has the *surface* for a meter but no logging (a few), or has no surface at all yet (the rest).

**Axis: visibility.** Hold one question constant across every band: *can we see what this layer costs?* Visibility is the right axis for this file because measurement *is* the act of making cost visible. Cost (file 01's axis) asks "what does it cost?"; visibility asks "can we see what it costs?". A layer with no meter is invisible by construction — and an invisible layer can't be on a budget.

**Seams.** Two load-bearing.

- **M1: emitted ↔ aggregated.** `tool_call_end.durationMs` is *emitted* on the event stream but never *aggregated*. The data exists for one investigation; it dies when the stream closes. Crossing this seam means writing per-investigation summary metrics to *somewhere* (a log, a sink, the dev cache file).
- **M2: returned ↔ logged.** Anthropic returns `res.usage` on every `messages.create` call — input tokens, output tokens, cache reads. The code accepts the response but never reads the `usage` field. The data is *returned* but never *logged*. This seam is the cheapest fix in the codebase: it's a property read.

```
  Structure pass — Measurement

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider · External    │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  visibility: can we see what this layer costs?    │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  M1: emitted ↔ aggregated   (per-call → totals)   │
  │  M2: returned ↔ logged      (res.usage exists)  ★ │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the one meter we have, the meters we don't, and the seams to cross.

---

## How it works

### Move 1 — the mental model

You've used `console.time` / `console.timeEnd` to figure out where a slow page is spending milliseconds — wrap the suspect, run it, read the number. That's the *whole shape* of measurement: a clock at the start, a clock at the end, a difference logged. Profilers add structure (call trees, flame graphs) and aggregation (p50, p95, p99 across many runs), but the irreducible kernel is "two clocks plus a sink." This codebase has the two clocks for one operation (the MCP tool call) and *no sink* — the number is emitted to the user's screen and then garbage-collected.

```
  Pattern — measurement's irreducible kernel

   START_CLOCK at operation entry
        │
        │  ... operation runs ...
        ▼
   END_CLOCK at operation exit
        │
        │  difference = elapsed time
        ▼
   ┌─ SINK ────────────────────────┐
   │  log line                     │  ← persistent (file/stdout)
   │  metric counter                │  ← aggregable (histogram)
   │  trace span                    │  ← linkable (parent-child)
   └────────────────────────────────┘

   blooming insights has: the two clocks for one op (MCP tool call)
   blooming insights is missing: a SINK that survives the stream close
```

The mental model: *every meter has a sink*. The sink determines what questions you can answer later. "How fast was this one call?" needs only a log line. "What's our p95 over the last hour?" needs a histogram. "Why was *this* trace slow?" needs spans with parent-child links. Today the sink is the user's browser — the data dies on refresh.

---

### Move 2 — the four meters, one at a time

#### Meter 1 — per-tool-call duration (the only one we have)

The kernel of measurement, applied to one operation. `McpClient.callTool` (`lib/mcp/client.ts:97-146`) captures `const start = Date.now()` before the call and computes `durationMs = Date.now() - start` after. The result is returned to the caller as `{ result, durationMs, fromCache }`. The agent loop attaches it to a `ToolCall` and emits a `tool_call_end` event with the duration.

```
  Meter 1 — per-tool-call duration
  ──────────────────────────────────────
  captured at:  lib/mcp/client.ts:112 (start) and :134 (end)
  surfaced as:  ToolCall.durationMs   (lib/mcp/types.ts)
  emitted as:   tool_call_end.durationMs   (lib/mcp/events.ts:7)
  displayed:    StatusLog and ToolCallBlock in the investigation view
  PERSISTED:    NO — the event stream is the sink; closes on done
  aggregated:   NO — no p50/p95/p99, no per-agent total

  what it CAN answer:    "did THIS call hit the cache?" (durationMs === 0)
                          "was THIS call slow?" (single point-in-time)
  what it CANNOT answer: "what's our typical investigation latency?"
                          "are we getting slower over time?"
                          "which tool is slowest on average?"
```

The boundary: this meter is *real* and works — but its sink is the user's eyeballs. The moment the investigation completes (or fails), the per-call timings vanish. Aggregating them would mean writing them to *somewhere* — the easiest sink is `console.log` (lands in Vercel function logs).

#### Meter 2 — `res.usage` from Anthropic (the meter that's *returned* but not *read*)

Every `anthropic.messages.create(...)` call returns a response object that includes `usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`. blooming insights calls `anthropic.messages.create` in five places:

- `lib/agents/base.ts:102` (the loop's main call — fires `maxTurns` times per agent)
- `lib/agents/diagnostic.ts:97` (the `synthesize()` fallback)
- `lib/agents/recommendation.ts:96` (the `synthesize()` fallback)
- `lib/agents/intent.ts:18` (the haiku classifier)

None of them read `res.usage`. The data is *received over the wire* on every call and *thrown away*.

```
  Meter 2 — res.usage (returned, never read)
  ──────────────────────────────────────────────────────────
  source:       Anthropic API response (every messages.create call)
  contains:     input_tokens, output_tokens, cache_creation, cache_read
  cost:         FREE — the network already delivered it
  status:       UNUSED in this codebase
  fix:          one line per call site: console.log(res.usage)
                + a tag for which agent + a tag for synthesize-vs-loop

  what it WOULD answer:  "what's the dollar cost of this investigation?"
                          "is the synthesize() call the dominant line item?"
                          "is the haiku classifier saving what we think it saves?"
                          "what's input-token-cost vs output-token-cost?"
```

This is the **cheapest fix in the entire codebase** for the **most consequential blind spot**. The cost concentration finding in `study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` is the *theoretical* observation that output tokens dominate; reading `res.usage` would turn it from theoretical to measured.

#### Meter 3 — per-investigation total (the missing aggregator)

A per-investigation summary doesn't exist anywhere. The route handler closes the stream when the agent finishes; no totals are computed. The information needed to compute one is already in scope — the `collected: AgentEvent[]` array in `app/api/agent/route.ts:171` holds every event of the run, including durations and (eventually, after Meter 2 lands) token counts.

```
  Meter 3 — per-investigation summary (computable but never computed)
  ────────────────────────────────────────────────────────────────────
  inputs available in scope:
    - collected array (every AgentEvent of the run)
    - request start timestamp (implicit at controller start)
  summary that COULD be computed at done:
    - total wall-clock duration
    - total tool calls (count by agent)
    - total cache hits vs misses (sum fromCache)
    - total token cost (once res.usage is logged)
    - count of synthesize() invocations
  status: not computed; collected is only used to PERSIST the replay events
          (saveInvestigation in lib/state/investigations.ts:30)

  what it WOULD answer:  "p50/p95 investigation latency"
                          "synthesize-trigger rate per agent"
                          "cache-hit rate per investigation"
                          "dollar cost per investigation"
```

The fix: between `send({ type: 'done' })` and the `saveInvestigation` call (`app/api/agent/route.ts:251-254`), compute and `console.log` a summary. One block of code, ~20 lines.

#### Meter 4 — load test (the synthetic baseline that doesn't exist)

A baseline is what you compare *against* when measuring a change. blooming insights' baseline is a comment in `app/api/agent/route.ts:18-19`: "A live investigation runs ~100-115s." Nobody re-runs this. If a refactor makes it 150s, nothing tells you — the comment doesn't update.

```
  Meter 4 — load test (the missing baseline)
  ──────────────────────────────────────────────────────────
  status:        not yet exercised
  why it matters: no synthetic baseline → no before/after evidence
                  a 30% latency regression would land silently

  the cheapest version that would help:
    - a script that triggers /api/briefing?demo=cached 10x serially
    - measures: total time, time-to-first-event, time-to-done
    - logs: per-event timestamps
    - the demo path is FREE (no Anthropic, no Bloomreach)
    - it would catch regressions in the streaming pipeline alone

  the next-level version:
    - 10x serial real /api/briefing (no demo) → real Anthropic + MCP latency
    - measures: full agent latency distribution
    - the cost is dollars + rate-limit consumption
```

The demo replay path is the easiest target: it doesn't touch Anthropic or Bloomreach, so it's free to run, and it exercises the NDJSON pipeline + the React stream consumer. A regression there shows up as a slower replay.

#### Meter 5 — profiler (also not yet exercised)

No Node.js profiler is integrated. No `--inspect` flag in the dev script, no `clinic` configured, no flame-graph capture. The closest thing is opening Chrome DevTools' Network panel and watching the NDJSON chunks arrive — useful for *one* investigation, useless for trends.

```
  Meter 5 — profiler integration (not yet exercised)
  ──────────────────────────────────────────────────────────
  status: not exercised in this codebase

  when it becomes worth it:
    - when Meters 1-3 say "we're slow" and you need to know WHY
    - when memory growth is suspected (cf. file 04)
    - when CPU is suspected (probably never for this workload —
       I/O dominates; CPU is mostly JSON.stringify)

  the cheapest version:
    - dev: `node --inspect ./node_modules/next/dist/bin/next dev`
            + Chrome DevTools → Performance tab
    - already-built tool: 0x for flame graphs of one request
```

The principle: **profilers are diagnostic tools, not monitoring tools**. You reach for them when measurement (Meters 1-3) tells you something is slow; you don't run them continuously. Today, Meters 1-3 don't exist either — so a profiler would just tell you which lines run, not whether the system is healthy.

---

### Move 3 — the baseline → measurement → fix loop

This is the principle the whole file orbits. Every performance change should follow the loop; without all four steps, the loop is broken.

```
  Pattern — the baseline → measurement → fix loop

   1. BASELINE      measure today's behavior (record the number)
        │
        ▼
   2. CHANGE        make the modification (cache, batch, refactor)
        │
        ▼
   3. RE-MEASURE    measure the changed behavior (record the number)
        │
        ▼
   4. COMPARE       baseline vs new → kept / reverted / iterated
        │
        ▼
   (the new number becomes next change's baseline)

   blooming insights today:
     1. BASELINE   = a comment in a route file
     2. CHANGE     = ships features, may or may not affect perf
     3. RE-MEASURE = does not happen
     4. COMPARE    = does not happen

   without 1+3, every change is "ship and hope."
```

The principle: **measurement is the difference between optimization and superstition**. The fixes already in this codebase (60s TTL cache, `maxToolCalls`, truncation, forced synthesis) are *good* fixes — they're shaped right, they match the constraints. But without the loop, the next refactor can quietly undo them and nobody knows. File 02's whole point is: the meter has to land before the next round of optimization is worth doing.

---

## Primary diagram

The full meter picture: what we have, what's returned-but-unread, what's computable-but-uncomputed, what's not exercised.

```
  blooming insights — the measurement landscape

  ┌─ UI ──────────────────────────────────────────────────────────────────┐
  │  no Web Vitals             not exercised                              │
  │  no React Profiler         not exercised                              │
  │  no client perf marks      not exercised                              │
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │
  ┌─ Route ──────────────────────▼────────────────────────────────────────┐
  │  collected: AgentEvent[]   has the inputs; never aggregates           │
  │  console.error on failure  Vercel logs only                           │
  │  no per-investigation summary  ★ MISSING (Meter 3)                    │
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │
  ┌─ Agent loop ─────────────────▼────────────────────────────────────────┐
  │  anthropic.messages.create   returns res.usage on every call          │
  │  res.usage logging           ★ ABSENT (Meter 2 — the cheapest fix)    │
  │  synthesize() call counter   ★ ABSENT (would reveal cost concentration)│
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │
  ┌─ Provider/transport ─────────▼────────────────────────────────────────┐
  │  ★ Meter 1 — tool_call_end.durationMs ★                                │
  │  emitted per call · displayed in UI · NOT persisted · NOT aggregated  │
  │  (lib/mcp/client.ts:112,134 · lib/mcp/events.ts:7)                     │
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │
  ┌─ External ───────────────────▼────────────────────────────────────────┐
  │  Anthropic res.usage (free, returned per call, never read)            │
  │  Bloomreach (no perf metadata returned)                               │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ Off-system (not yet exercised) ──────────────────────────────────────┐
  │  ★ Meter 4 — load test (synthetic baseline)                            │
  │  ★ Meter 5 — profiler integration (clinic, 0x, --inspect)              │
  │  APM (Sentry, Datadog) — not integrated                               │
  │  Vercel Speed Insights / Analytics — not enabled                      │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where measurement happens (and doesn't)

- **Meter 1 (tool-call duration)** — captured every time the agent loop calls a tool through `McpClient`. Displayed live in the investigation page's status sidebar (`StatusLog`), so the user can see "the get_event_schema call took 1.2s." Not aggregated; vanishes on stream close.
- **Meter 2 (res.usage)** — would land at the five `anthropic.messages.create` call sites (`lib/agents/base.ts:102`, `lib/agents/diagnostic.ts:97`, `lib/agents/recommendation.ts:96`, `lib/agents/intent.ts:18`). A single `console.log({ agent, kind, ...res.usage })` per site would make cost visible.
- **Meter 3 (per-investigation summary)** — would land at the `send({ type: 'done' })` lines in both routes (`app/api/agent/route.ts:251`, `app/api/briefing/route.ts:246`), computing totals from the `collected` array (or its equivalent for briefing).
- **Meter 4 (load test)** — a script in `scripts/` that calls `/api/briefing?demo=cached` N times and prints latency stats. The repo already has `scripts/bake-demo-coverage.ts`, so this would extend an existing pattern.

### Code side by side

**Meter 1 — captured cleanly, then dropped on the floor.**

```
  lib/mcp/client.ts  (lines 110–135)

  async callTool<T = unknown>(...): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };  ← cache hit reads 0ms
      }
    }

    const start = Date.now();                                                    ← clock 1
    let result = await this.liveCall(name, args);

    // ... retry loop ...

    const durationMs = Date.now() - start;                                       ← clock 2
        │
        └─ this is THE measurement. It includes the spacing gate's sleep,
           the actual network round-trip, and any retry waits. It's then
           returned to the caller (the agent loop) and emitted on the
           NDJSON stream — but nothing aggregates it. A `console.log` here
           would land it in Vercel function logs and survive the stream
           close. Today the data dies when the stream closes.
```

**The five Anthropic call sites — none of them read res.usage.**

```
  lib/agents/base.ts  (line 102)         ← main loop, fires maxTurns × maxAgents times per investigation
  lib/agents/diagnostic.ts  (line 97)    ← synthesize() fallback — output-token-heavy
  lib/agents/recommendation.ts  (line 96)← synthesize() fallback — output-token-heavy
  lib/agents/intent.ts  (line 18)        ← haiku classifier — cheap, fires once per ?q= query

  const res = await this.anthropic.messages.create({ ... });   ← receives res.usage on the wire
        │
        └─ the response object includes:
             res.usage.input_tokens
             res.usage.output_tokens
             res.usage.cache_read_input_tokens     (always 0 — we don't prompt-cache)
             res.usage.cache_creation_input_tokens (always 0 — same reason)
           the data is free; it's already delivered. Adding one
           console.log per call site would turn the cost concentration
           finding from theoretical to measured.
```

**The per-tool-call duration as seen by the UI consumer — it's there, displayed, then thrown away.**

```
  lib/hooks/useInvestigation.ts  (lines 86–95)

  const replaceRunningTool = (arr: TraceItem[], e: Extract<AgentEvent, { type: 'tool_call_end' }>) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
        arr[i] = { ...it, status: 'done', durationMs: e.durationMs, result: e.result, error: e.error };
                                          ↑
                                          ↑ used for ONE thing: showing in the UI
      }
    }
    return arr;
  };
        │
        └─ The duration travels from McpClient → ToolCall → AgentEvent →
           NDJSON line → useInvestigation hook → TraceItem → ToolCallBlock
           component. It's rendered as "1.2s" in the status panel. When
           the user navigates away, the data is garbage-collected.
           NO persistence, NO aggregation, NO histogram.
```

---

## Elaborate

**Where this pattern comes from.** The "you can't optimize what you can't measure" principle traces to Tony Hoare and Donald Knuth ("premature optimization is the root of all evil" — the rarely-quoted second half is "*yet we should not pass up our opportunities in that critical 3%*" which requires measurement to find). Modern observability (USE method, RED method, SRE's golden signals) all reduce to: *measure latency, traffic, errors, and saturation; if you can't measure one of those, you can't reason about it*. blooming insights measures latency for *one operation type* (MCP tool calls), measures none of the rest, and the gaps are visible.

**Why the cheapest fix matters most.** Reading `res.usage` is the cheapest fix in the whole codebase — five `console.log` lines — and it unblocks the most consequential blind spot (cost). The asymmetry between "5 lines of code" and "first time anyone knows what an investigation costs" is the whole reason this fix is the top recommendation in file 08.

**Why the demo path is the best load-test target.** The demo path (`?demo=cached`) replays a snapshot — no Anthropic, no Bloomreach, no rate limits, no dollars. It exercises the NDJSON pipeline, the React state machine in `useInvestigation`, and the rendering path. A regression there (e.g. a refactor that doubles the time per replayed event) is a regression in *our* code, isolated from the external dependencies' noise. It's the cleanest baseline available.

**Connection to adjacent concepts.** This file is the prerequisite for every soft budget in file 01. It's also the prerequisite for file 06's claim that the cache is "saving" time — without the meter, "saving" is an assumption. File 08 ranks the missing-measurement risks alongside the rest of the audit.

---

## Interview defense

### Q: What's the one performance number you can actually see in blooming insights today?

**Answer:** Per-tool-call duration. `McpClient.callTool` captures it (`lib/mcp/client.ts:112,134`), the agent loop attaches it to a `ToolCall`, and the route emits it as `tool_call_end.durationMs` on the NDJSON stream (`lib/mcp/events.ts:7`). The UI shows it live in the investigation page's status sidebar. The data dies when the stream closes — there's no aggregation, no histogram, no per-investigation summary. So I can answer "did *this* call hit the cache?" (durationMs === 0) but not "what's our p95?"

```
  Meter 1 — the one number we see
   START_CLOCK  (Date.now())
   ─── liveCall ───
   END_CLOCK    (Date.now())
        │
        ▼
   ToolCall.durationMs  → tool_call_end event  → UI status panel
                                                          │
                                                          └─ garbage-collected on close
```

### Q: What measurement would you add first, and why?

**Answer:** `res.usage` logging on every `anthropic.messages.create` call — five call sites, one `console.log` each. It's the cheapest fix in the codebase and unblocks the most consequential blind spot. Today nobody knows what an investigation costs in tokens. The `synthesize()` fallback in `diagnostic.ts` and `recommendation.ts` is *suspected* to be the dominant output-token line item (it emits a full structured JSON), but nothing confirms it. Five log lines confirm it. That's the leverage.

```
  why res.usage first

   the data is FREE (returned on every call, currently dropped)
   the fix is FIVE LINES (one console.log per call site)
   the unlock is HUGE (cost becomes visible for the first time)
   the gate it removes is BIG (any cost-related budget becomes possible)
```

### Q: There's no load test in this codebase. What's the cheapest one to add?

**Answer:** A script that hits `/api/briefing?demo=cached` ten times serially and logs (total time, time-to-first-event, time-to-done). The demo path doesn't touch Anthropic or Bloomreach, so it's free to run and exercises only our code — the NDJSON pipeline, the route's stream construction, the replay pacing. A regression there is a regression in *our* code, not noise from the external dependencies. It would catch streaming-pipeline regressions silently introduced by, say, a route-handler refactor.

```
  cheapest load test — leverages the demo path

   demo=cached  →  no Anthropic, no MCP, no rate limit, no $$$
                   exercises: NDJSON write, React stream read,
                              useInvestigation state machine,
                              StatusLog render path
   10× serial   →  enough to see a trend, fast (~10× 30s = 5min)
   logs:        →  total / TTFE / TTD per run + per-event ts
```

---

## Validate

**Level 1 — Reconstruct.** Name the one thing blooming insights measures today, where it's captured, where it's emitted, and where it dies. (Answer: per-tool-call duration. Captured at `lib/mcp/client.ts:112` and `:134`. Emitted as `tool_call_end.durationMs` per `lib/mcp/events.ts:7`. Dies when the NDJSON stream closes — no persistence, no aggregation.)

**Level 2 — Explain.** Why is reading `res.usage` "the cheapest fix in the codebase for the most consequential blind spot"? (Answer: the data is already returned on every Anthropic call — the network delivered it for free. Reading it requires one property access per call site (5 sites). The blind spot it removes is cost: today no one knows what an investigation costs in tokens, and the suspected dominant line item — the output-heavy `synthesize()` call — is unconfirmed. Five log lines change that.)

**Level 3 — Apply.** A teammate says "the briefing feels slower this week — can you check?" What can you actually answer today? (Answer: nothing rigorous. The `tool_call_end.durationMs` for a single run is visible in the UI status panel, but there's no baseline to compare against — no history, no aggregation. You could open the demo-replay run and compare per-event timing to a colleague's screen, but that's not a measurement. The honest answer is "we don't have the meter to answer that yet" and propose adding Meter 3 (per-investigation summary log line) to start building a baseline.)

**Level 4 — Defend.** A reviewer says "we're shipping fine without measurement — why add the overhead?" Defend the meter. (Answer: the overhead is negligible — `console.log` of `res.usage` is microseconds; `Date.now()` differences are already captured. The shipping-fine claim conflates *no visible problems* with *no problems*. Today, a 30% cost regression would land silently — and the regressions most likely to land are exactly the ones around the cost concentration (the `synthesize()` call). Without `res.usage`, every change to the prompt, the schema summary, or the truncation limit is "ship and hope." The cost is a couple of log lines; the value is a true before/after for every future change.)

---

## See also

- `01-performance-budget.md` — the soft budgets that need this file's meters to exist
- `03-latency-throughput-and-tail-behavior.md` — the latency landscape this file would let us measure
- `06-caching-batching-and-backpressure.md` — the cache whose hit rate this file would let us aggregate
- `08-performance-red-flags-audit.md` — "no res.usage logging" is the #1 finding
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — the cost theory this file would let us prove
- `.aipe/study-debugging-observability/` (sibling guide) — broader observability frame; this file is the perf-specific cut
