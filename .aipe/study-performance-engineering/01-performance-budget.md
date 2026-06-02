# Performance budget

**Industry name(s):** performance budget · latency budget · capacity budget · "the contract"
**Type:** Industry standard · Language-agnostic

> blooming insights ships **four hard budgets** — `maxDuration = 300s` per route (`app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`), `maxToolCalls` per agent (6/6/6/4), `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts:29`), and `minIntervalMs = 1100` (`lib/mcp/connect.ts:92`) — and **zero soft budgets** (no p99 latency target, no error-rate SLO, no cost-per-investigation cap). Every budget here was set by *judgment* about the constraints (Vercel Pro's 300s ceiling, Bloomreach's ~1 req/s, Anthropic's variable latency), not by measurement. That's defensible at hackathon scale; it's the load-bearing reason file 02 is mostly "what we don't measure."

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A performance budget is a contract between *what the system promises* (a feed loads in ≤ X seconds, an investigation finishes in ≤ Y seconds, a call costs ≤ Z dollars) and *what each layer is allowed to spend* to keep that promise. The promise is user-visible; the per-layer spend is system-visible. When you've never written either down, every change is unbounded — you can't tell if a refactor moved the budget or just shuffled the spend.

```
  Zoom out — where each budget lives           ← we are here (every band carries a number)

  ┌─ UI (Next.js 16, React 19) ──────────────────────────────────┐
  │  no measured budget                                            │
  │  skeletons hide latency until events arrive                    │
  │  no LCP/INP target, no Web Vitals collection                   │
  └────────────────────────────┬─────────────────────────────────┘
                               │ NDJSON chunked stream
  ┌─ Route layer ──────────────▼─────────────────────────────────┐
  │  ★ maxDuration = 300s ★  (BUDGET 1 — route ceiling)            │
  │  app/api/agent/route.ts:20   app/api/briefing/route.ts:17     │
  └────────────────────────────┬─────────────────────────────────┘
                               │
  ┌─ Agent loop ───────────────▼─────────────────────────────────┐
  │  ★ maxToolCalls 6/6/6/4 ★  (BUDGET 2 — per-agent call cap)    │
  │  ★ MAX_TOOL_RESULT_CHARS = 16_000 ★ (BUDGET 3 — context cap) │
  │  monitoring.ts:101 · diagnostic.ts:62 · query.ts:41 ·         │
  │  recommendation.ts:57 · base.ts:29                            │
  └────────────────────────────┬─────────────────────────────────┘
                               │
  ┌─ Provider/transport ───────▼─────────────────────────────────┐
  │  ★ minIntervalMs = 1100 ★  (BUDGET 4 — per-call latency floor)│
  │  lib/mcp/connect.ts:92                                         │
  │  (this is rate-limit COMPLIANCE, not a perf budget — but it    │
  │  enforces a floor every other budget hangs off of)             │
  └────────────────────────────┬─────────────────────────────────┘
                               │
  ┌─ External providers ───────▼─────────────────────────────────┐
  │  Bloomreach MCP — ~1 req/s/user GLOBAL                         │
  │  Anthropic — observed latency variance, no measured p95       │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what is each layer allowed to spend, who set the number, and what happens when the number is wrong?* Below, you'll see the four budgets blooming insights writes down, the budgets it doesn't (cost, latency-target, error-rate), the way the budgets compose (Budget 4 sets the *floor*; Budget 2 caps the *count*; Budget 1 catches what falls through), and the failure mode when a budget is wrong — the agent loop exits without producing JSON, or the route times out at 300s with a half-written stream.

---

## Structure pass

**Layers.** Four bands hold budgets: Route (`maxDuration`), Agent loop (`maxToolCalls` + `MAX_TOOL_RESULT_CHARS`), Provider (`minIntervalMs`), and External (Bloomreach + Anthropic — *not* our budget, but the constraints our budgets answer to).

**Axis: cost (latency + dollars), with the question "who set this number?" held constant.** Hold one question across every band: *what's this budget, who decided it, and what does it cost when it's wrong?* Cost is the right axis because a budget is fundamentally a cost cap — latency cost (the user waits), token cost (the bill grows), or quota cost (the rate limit retaliates). Pick "control" and you flatten the contract into a fixed pipeline; pick "failure" and you'd duplicate file 06 of `study-system-design`. Cost — paid by whom, on which axis, against which ceiling — is the lens that makes budgets legible.

**Seams.** Two load-bearing.

- **B1: judgment ↔ measurement.** Today, every budget is set by judgment (300s "should fit a typical investigation", `maxToolCalls=6` "is enough exploration"). Crossing this seam means measuring p95 latency and setting the budget at p95 + headroom. It's the seam that makes file 02 mostly empty.
- **B2: hard ↔ soft.** Hard budgets fail loudly (Vercel kills the route at 300s; the agent loop forces synthesis at `maxToolCalls`). Soft budgets fail silently (no cost cap means a runaway agent burns dollars before anyone notices). All four codified budgets are hard. There are no soft ones, which is *also* a choice — soft budgets need a meter.

```
  Structure pass — Performance budget

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Route · Agent loop · Provider · External         │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  cost: latency / tokens / quota                   │
  │  question: who set this number, what if it's wrong?│
  └────────────────────────┬─────────────────────────┘
                           │  trace it across layers
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  B1: judgment ↔ measurement   ★ the missing meter │
  │  B2: hard ↔ soft   (all 4 are hard; none soft)    │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks each budget, who set it, what happens when it's wrong, and the soft budgets that aren't written down.

---

## How it works

### Move 1 — the mental model

You've shipped React apps with a "spinner threshold" — if a fetch is going to take longer than ~300ms, show a spinner so the user doesn't think the page is broken. That's a perf budget: a number that says "above this, the UX breaks." This system has the same shape at every layer, just nested. The whole investigation has a ceiling (300s — Vercel kills it). The agent loop inside has a ceiling (`maxToolCalls`). The single MCP call has a floor (`minIntervalMs` — the spacing gate). The tool result has a size cap (16k chars). Each ceiling exists because the *next layer up* has its own ceiling that ours must fit under.

```
  Pattern — budgets compose top-down (each layer fits under the next)

  external constraints (NOT our budget — set by others)
       Vercel Pro maxDuration: 300s
       Bloomreach: ~1 req/s/user GLOBAL
       Anthropic: latency variance ~3-10s per agent call
                │
                ▼
  OUR BUDGET 1 — route       maxDuration = 300s
                │  (fits under Vercel's ceiling exactly)
                ▼
  OUR BUDGET 2 — agent       maxToolCalls = 6 (mon/diag/query) or 4 (rec)
                │  (6 × 1.1s spacing + 6 × ~3-10s Anthropic = ~25-67s per agent)
                ▼
  OUR BUDGET 3 — tool ctx    MAX_TOOL_RESULT_CHARS = 16_000
                │  (bounds the context handed back to Claude per call)
                ▼
  OUR BUDGET 4 — call floor  minIntervalMs = 1100
                   (the per-call latency floor; not a cap, a floor)
```

The model is: *budgets nest*. The route budget caps the whole investigation; the agent budget caps the per-agent loop inside it; the tool-context budget caps what each loop iteration carries forward; the spacing floor sets the minimum time a single call takes. When you change one, you change what the next one can promise.

---

### Move 2 — the four budgets, one at a time

#### Budget 1 — route ceiling (`maxDuration = 300s`)

The single biggest number in the system. You know `fetch()` to a Next.js route — the route runs on a serverless function with a wall-clock ceiling. On Vercel Pro the ceiling is 300 seconds; on Hobby it's 60. blooming insights pins the route to 300s because, as the comment at `app/api/agent/route.ts:18-19` says verbatim, "A live investigation (diagnostic → recommendation) runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it."

```
  Budget 1 — route ceiling
  ──────────────────────────────────────
  set by:    Vercel plan (max possible)
  pinned at: 300 (exactly the ceiling)
  measured?  NO — judgment based on observed ~100-115s runs
  fails how? Vercel kills the function; client sees the stream cut mid-event
  fix path:  break the agent run out of the route (queue + worker)
             → would lift the budget but require a database (study-system-design/07)
```

The boundary: a 300s budget set "at the ceiling" leaves *zero headroom*. If Bloomreach has a slow day and rate-limit retries pile up, or Anthropic returns slow on a sonnet call, the investigation runs past 300s and the user gets a half-finished stream. Today there's no measurement that would tell you which call exceeded budget — only the error log shows the run died.

#### Budget 2 — per-agent tool-call cap (`maxToolCalls`)

The agent loop in `runAgentLoop` (`lib/agents/base.ts:85`) is a Claude tool-use loop — Claude responds with `tool_use` blocks, the loop executes them through MCP, feeds the results back, and Claude responds again. Without a cap, the model can keep "wanting to query" forever (the prompt-engineering guide has the receipts).

`maxToolCalls` is the hard cap. When the running count of tool calls reaches it, the loop sets `budgetSpent = true`, omits the tools from the next request, and appends `synthesisInstruction` to the system prompt forcing the model to emit its final JSON answer.

```
  Budget 2 — per-agent tool-call cap
  ──────────────────────────────────────
  monitoring:     6   (lib/agents/monitoring.ts:101)
  diagnostic:     6   (lib/agents/diagnostic.ts:62)
  query:          6   (lib/agents/query.ts:41)
  recommendation: 4   (lib/agents/recommendation.ts:57)
  set by:    judgment ("enough exploration to test 2-3 hypotheses")
  measured?  NO — no count of how often the cap is HIT vs cleanly exited
  fails how? "soft" — if hit, the model is forced to synthesize from partial evidence;
             confidence is downgraded (diagnostic.ts:82) but the request still succeeds
  fix path:  count hit-rate per agent over a week; raise/lower per measurement
```

The boundary: this is the only budget with a *graceful* failure mode. When the model hits it, the forced-synthesis path still emits a structured answer — see file 03 for the latency cost of those forced turns and file 06 for the boundary between "wanted more data" and "deliberately stopped."

#### Budget 3 — tool-result context cap (`MAX_TOOL_RESULT_CHARS = 16_000`)

Every tool call's result is stringified and truncated at 16k characters before being fed back to Claude as a `tool_result` block (`lib/agents/base.ts:29-34`). Without this, a `get_event_schema` returning a 112KB JSON would be re-tokenized on every subsequent turn — input tokens grow O(turns × schema_size) and the bill scales with the conversation length.

```
  Budget 3 — tool-result context cap
  ──────────────────────────────────────
  set at:    16_000 chars (~4-5k tokens)
  applied:   lib/agents/base.ts:31-34 (truncate function)
  reapplied: app/api/agent/route.ts:99-103 (TRUNC = 4000) for the EVENT stream out
  set by:    judgment ("big enough to be useful, small enough not to blow context")
  measured?  NO — no histogram of how often truncation kicks in or by how much
  fails how? truncation is silent (appends '…[truncated]'); the model loses the tail
  fix path:  emit a metric when truncation fires + by-how-much; tune per p95
```

A subtle gotcha: the *route* truncates results harder (4000 chars) than the *loop* (16_000 chars) — because the route is feeding the *UI*'s status panel, not the *model's* next turn. Two different consumers, two different budgets, both written down.

#### Budget 4 — per-call latency floor (`minIntervalMs = 1100`)

The spacing gate in `McpClient.liveCall` (`lib/mcp/client.ts:148-152`) computes `elapsed = Date.now() - lastCallAt`; if `elapsed < minIntervalMs`, it sleeps the difference. Set to 1100 in `lib/mcp/connect.ts:92`. This isn't a cap — it's a *floor*. Every single MCP call takes *at least* 1.1 seconds wall-clock before the actual network round-trip starts (measured from the prior call's end).

```
  Budget 4 — per-call latency floor (rate-limit compliance, not throttling)
  ──────────────────────────────────────────────────────────────────────────
  set at:    1100 ms
  set by:    Bloomreach's observed rate-limit window ("1 per 1 second" → 1100 = 1s + 100ms headroom)
  measured?  YES — emitted as `tool_call_end.durationMs` (lib/mcp/events.ts:7)
             but NOT aggregated anywhere; only visible per-call in the trace
  fails how? cannot — it's a sleep, not a check. It always succeeds.
  fix path:  if Bloomreach raises the per-user limit, lower it. Otherwise stay put.

  composes with Budget 2:
     6 tool calls × 1100 ms floor = 6.6 s minimum spacing per agent
     + Anthropic latency per turn (3-10s × 6 turns)
     + tool call latency itself (200ms-2s observed)
     = total agent latency floor / typical / ceiling
```

The composition is what file 03 spends most of its time on. Budget 4 is a *constraint*, not a goal — you can't lower it without breaking Bloomreach's rate limit; you can't raise it without slowing every investigation.

---

### Move 3 — the budgets that aren't written down

The four above are the codified ones. Three obvious budgets do *not* exist anywhere in the codebase:

```
  ┌─ SOFT BUDGETS — not codified, not measured ────────────────┐
  │                                                              │
  │  ★ Cost per investigation                                    │
  │      no res.usage logging anywhere                           │
  │      no per-investigation dollar cap                         │
  │      no model-tier escalation policy (sonnet on every agent) │
  │      the synthesize() call is the dominant unmeasured spend  │
  │                                                              │
  │  ★ p95/p99 latency target                                    │
  │      no SLO ("an investigation completes in ≤ N seconds")    │
  │      no histogram of per-investigation duration              │
  │      the 300s ceiling is the only number                     │
  │                                                              │
  │  ★ Error-rate budget                                         │
  │      no SLO ("≤ X% of investigations may fail")              │
  │      no count of rate-limit hits per investigation           │
  │      data-quality note in the UI counts errors per RUN,      │
  │      but never aggregates across runs                        │
  └──────────────────────────────────────────────────────────────┘
```

The principle: **a budget without a meter is a hope**. The four hard budgets work because the *next layer up* enforces them (Vercel kills at 300s; the loop counts tool calls; the truncate function applies the char cap; the sleep enforces the floor). The three missing soft budgets don't have an enforcer because nothing measures the cost. File 02 is the meter design that would let you set them.

---

## Primary diagram

The whole budget picture in one frame: the hard budgets at each layer, what they're bounded by, and what's missing.

```
  blooming insights — the full performance-budget contract

  ┌─ External constraints (THEIRS — not our budget) ───────────────────────┐
  │  Vercel Pro: 300s max                                                  │
  │  Bloomreach: ~1 req/s/user GLOBAL                                      │
  │  Anthropic: per-call latency variance                                  │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │  our budgets fit under these
  ┌─ Route layer ────────────────▼─────────────────────────────────────────┐
  │  maxDuration = 300s   ← BUDGET 1 (HARD, hits ceiling)                   │
  │  app/api/agent/route.ts:20  ·  app/api/briefing/route.ts:17            │
  │  enforcer: Vercel kills the function                                    │
  │  measured? NO histogram, NO p95                                         │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │
  ┌─ Agent loop ─────────────────▼─────────────────────────────────────────┐
  │  maxToolCalls = 6/6/6/4   ← BUDGET 2 (HARD, graceful)                  │
  │  MAX_TOOL_RESULT_CHARS = 16_000   ← BUDGET 3 (HARD, silent)            │
  │  enforcer: runAgentLoop (base.ts:90, base.ts:32)                       │
  │  measured? per-call durationMs YES, per-agent totals NO                │
  │                                                                          │
  │  ★ MISSING: cost-per-call budget — no res.usage logged                  │
  │  ★ MISSING: synthesize() call counter (its trigger rate is invisible)   │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │
  ┌─ Provider/transport ─────────▼─────────────────────────────────────────┐
  │  minIntervalMs = 1100   ← BUDGET 4 (FLOOR — rate-limit compliance)     │
  │  lib/mcp/connect.ts:92                                                  │
  │  enforcer: McpClient.liveCall sleeps                                   │
  │  measured? durationMs per call YES (emitted on event stream)           │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ NOT codified anywhere ────────────────────────────────────────────────┐
  │  SLO (p95 latency target)        no                                    │
  │  SLO (error rate)                no                                    │
  │  Cost per investigation           no                                   │
  │  Web Vitals (LCP/INP/CLS)        no                                   │
  │  Per-agent token budget          no                                   │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where the four budgets are reached for

- **Budget 1 (route ceiling)** — set on both NDJSON-streaming routes that drive agent work; the briefing route runs the monitoring scan, the agent route runs the diagnostic/recommendation chain. Both can take 100+ seconds in live mode.
- **Budget 2 (per-agent calls)** — set per agent class at construction of its `runAgentLoop` invocation. Recommendation gets 4 (it has a narrower job — validate diagnosis + propose actions); monitoring/diagnostic/query get 6.
- **Budget 3 (tool-result chars)** — applied inside the loop *before* feeding the tool result back to Claude (the model's context). Also applied separately at the *route* (the UI's event stream) at a tighter 4k cap, so the live status panel doesn't render a 16k blob.
- **Budget 4 (per-call floor)** — set once at connect time; applies to every MCP call for that connection's lifetime.

### Code side by side

**Budget 1 + the rationale comment that names the constraint.**

```
  app/api/agent/route.ts  (lines 18–20)

  // 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)  ← the rationale, in code
  // runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.       ← judgment, not measurement
  export const maxDuration = 300;                                                  ← the budget, pinned at ceiling
        │
        └─ removing this line drops the route to Vercel's default (60s on Hobby,
           higher on Pro). The investigation would die mid-recommend almost
           every time. This is the load-bearing budget for the whole system.
```

**Budget 2 + the forced-synthesis trigger.**

```
  lib/agents/base.ts  (lines 88–101)

  // Omit tools when the model must now produce a final answer instead of
  // another tool call — guarantees a non-empty response and bounds latency:
  //   - on the final allowed turn, or
  //   - once the hard tool-call budget (maxToolCalls) is reached.
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  ← Budget 2 trip
  const forceFinal = turn === maxTurns - 1 || budgetSpent;                              ← either trigger
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
  };
  if (!forceFinal) params.tools = toolSchemas;                                          ← drop the tools
        │
        └─ when Budget 2 trips, the model is given the synthesis instruction
           and NO tools. This is the graceful failure mode: the model can't
           call another tool even if it wants to. Without this, the model
           would keep wanting to query past the budget. (cf. study-prompt-engineering)
```

**Budget 3 — the truncate function used twice with two different caps.**

```
  lib/agents/base.ts  (lines 29–34)

  const MAX_TOOL_RESULT_CHARS = 16_000;                                ← Budget 3 (model-context cap)

  function truncate(s: string): string {
    if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
    return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';       ← silent — model loses the tail
  }
        │
        └─ used at base.ts:150 to bound what's fed back to Claude. A SECOND
           truncate (TRUNC = 4000) in app/api/agent/route.ts:99-103 bounds
           what's sent to the UI event stream. Same pattern, two consumers,
           two budgets.
```

**Budget 4 — the spacing gate.**

```
  lib/mcp/client.ts  (lines 148–163)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;                       ← time since last call
    if (elapsed < this.minIntervalMs) {                                 ← under the floor?
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  ← sleep the difference
    }
    try {
      const result = await this.transport.callTool(name, args);          ← actual network call
      this.lastCallAt = Date.now();                                      ← reset the clock
      return result;
    } ...
  }
        │
        └─ this sleeps an average of ~1100 - tool_latency ms before EVERY
           MCP call. It's the per-call latency floor: even a cache miss with
           a 200ms server is bottlenecked here. Budget 4 + Budget 2 set the
           per-agent minimum latency: 6 calls × ~1.1s = ~6.6s spacing alone.
```

---

## Elaborate

**Where this pattern comes from.** Performance budgeting as a discipline came out of frontend in the early 2010s (Tim Kadlec, Lara Hogan) — the idea that performance is a *feature with a budget*, not "as fast as possible." It generalized into latency budgets (Google SRE), error budgets (the SLO/SLA framework), and cost budgets (FinOps). The shared spine across all variants: a number, set in advance, that says "above this, we have to stop and rethink — not just keep going."

**Why hard budgets ship first.** Hard budgets are easier than soft ones because they need no meter — Vercel enforces 300s for you, the loop enforces `maxToolCalls` for you, the truncate function enforces 16k for you. Soft budgets (cost, latency target, error rate) need a measurement infrastructure that doesn't exist yet. File 02 is where that meter would live.

**What changes when measurement arrives.** Once `res.usage` is logged per call and per-investigation totals are persisted, three budgets become possible: (a) a per-investigation dollar cap (`abort if cost > $X`), (b) a per-investigation p95 latency SLO (`alert if p95 > Ns over the last 100 investigations`), and (c) a per-agent token budget (`force synthesis if input_tokens > N`). All three would compose into the existing budget hierarchy — Budget 1 catches them all if they slip.

**Connection to adjacent concepts.** File 02 is the meter that would let you write soft budgets. File 06 explains why the 60s TTL cache is set the way it is (and how it makes Budget 4 cheaper). File 08 ranks the missing-budget risks against the rest of the audit.

---

## Interview defense

### Q: What's the most consequential perf budget in blooming insights, and who set it?

**Answer:** `maxDuration = 300s` on the agent and briefing routes (`app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`). Vercel Pro set the ceiling; we pinned to it. The judgment was that a live investigation runs ~100-115s and we need headroom for rate-limit retries plus Anthropic latency variance. The cost of pinning at the ceiling is *zero headroom* — if Bloomreach has a slow day, the run dies at 300s with the stream cut mid-event. The fix is to break the agent run out of the route (queue + worker), which removes the budget but requires a database we don't have.

```
  the 300s budget — what it costs to be at the ceiling

   judgment-set ceiling: 300s
        │
        └─ typical investigation: ~100-115s   ←  headroom: ~185s
        └─ slow day (3 rate retries × 10s):   ~145s   ←  headroom: ~155s
        └─ Anthropic 95th-pctile day:         ~200s   ←  headroom: ~100s
        └─ all of the above at once:          ~280-310s  ←  HEADROOM: 0 or negative
                                                          ←  RUN DIES MID-STREAM
```

### Q: You have four hard budgets and zero soft budgets — why?

**Answer:** Hard budgets are enforced by the layer above (Vercel kills at 300s; the loop counts calls; the truncate function clips chars; the sleep enforces the floor). They need no meter. Soft budgets — cost, p95 latency, error rate — need measurement infrastructure that doesn't exist in this codebase. There's no `res.usage` logging on any Anthropic call, no per-investigation duration histogram, no aggregated error-rate counter. Adding any of those is a small code change (less than 50 lines for `res.usage` logging) — but until they're added, every soft budget would be a hope, not a contract.

```
  why no soft budgets

   hard: Vercel killing route → enforced for free
   hard: loop counting calls → enforced inside our code
   hard: truncate clipping chars → enforced inline
   hard: sleep enforcing floor → enforced inline

   soft: cost per investigation → needs a meter (res.usage)        ← absent
   soft: p95 latency target → needs a histogram                    ← absent
   soft: error rate → needs aggregation across runs                ← absent
```

### Q: The 60s TTL cache and the 1100ms spacing — same layer, opposite role. Explain.

**Answer:** The spacing (`minIntervalMs = 1100`) is the *floor* — every call takes at least 1.1s wall-clock. The cache is the *escape hatch* from that floor: a cache hit returns in 0ms (`durationMs: 0, fromCache: true` in `lib/mcp/client.ts:108`), bypassing both the spacing and the network. They compose: spacing makes every miss expensive (~1.1s + network); the cache makes a hit free; the 60s TTL bounds how stale the cached answer can be. If you raised the spacing to 10s (the worst-case Bloomreach window), the cache would be saving you 10s per hit instead of 1.1s — that's the leverage that makes the cache worth it.

---

## Validate

**Level 1 — Reconstruct.** Name the four codified budgets in blooming insights with file:line evidence. (Answer: `maxDuration = 300` at `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17`; `maxToolCalls = 6/6/6/4` in `lib/agents/monitoring.ts:101`, `lib/agents/diagnostic.ts:62`, `lib/agents/query.ts:41`, `lib/agents/recommendation.ts:57`; `MAX_TOOL_RESULT_CHARS = 16_000` at `lib/agents/base.ts:29`; `minIntervalMs = 1100` at `lib/mcp/connect.ts:92`.)

**Level 2 — Explain.** Why does Budget 3 have two values (16_000 in the loop, 4_000 in the route) for the same thing? (Answer: two consumers — the loop's truncate feeds the *model* its next-turn context; the route's TRUNC feeds the *UI* its status-panel display. Two budgets because the costs differ — model context costs tokens, UI display costs paint time.)

**Level 3 — Apply.** A new agent is being added that proposes ad copy from the diagnosis. The recommendation it inherits from `RecommendationAgent` would give it `maxToolCalls = 4`. Should the new agent get more or fewer? Why? (Answer: depends on whether it needs to *fetch* more data or just *generate* text. Pure-generation agents need 0 tool calls. If it needs to verify candidate copy against the workspace catalog, 2-3 calls. The "set by judgment" pattern means whatever number you pick should be revisited after seeing the agent's actual hit rate on the cap — count how often it terminates by hitting the cap vs cleanly.)

**Level 4 — Defend.** A reviewer says "300s is too long — users will abandon." Defend or change the budget. (Answer: the budget isn't the *target*, it's the *ceiling*. The route streams progressively from the first event (the `stepFor` thought before bootstrap completes — `app/api/agent/route.ts:198-201`); the UI shows activity within ~1-2s and the user sees the diagnosis as soon as it's emitted (~30-60s), not at 300s. The 300s is what the *slowest* run is allowed to take. If we wanted to enforce abandonment-resistant UX, the right move is a p95 *target* under the ceiling — say, 90s — and alert when it's breached. That's a soft budget; today we don't have one.)

---

## See also

- `02-measurement-baselines-and-profiling.md` — the meter that would let soft budgets exist
- `03-latency-throughput-and-tail-behavior.md` — how Budgets 2 and 4 compose into total latency
- `06-caching-batching-and-backpressure.md` — the 60s TTL that lets Budget 4 be cheaper on a hit
- `08-performance-red-flags-audit.md` — the ranked risks, including "no soft budgets"
- `.aipe/study-system-design/07-scale-bottlenecks-and-evolution.md` — why Budget 1 is the second ceiling that breaks at 100x
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — the cost budget that doesn't exist yet
