# Parallel fan-out / fan-in

**Industry name(s):** Parallel fan-out, fan-out fan-in, scatter-gather, map-reduce-style agents
**Type:** Industry standard · Language-agnostic

> Independent sub-jobs run simultaneously; a merger combines the results. blooming insights does NOT fan out — the pipeline is sequential, user-gated, and the ~1 req/s MCP rate limit makes wide concurrency a poor fit. The topology that earns its overhead the day independent sub-questions across multiple domains arrive in one request.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Parallel fan-out would replace the Pipeline coordinator band's *shape* — instead of a sequential `monitoring → diagnostic → recommendation` chain, you'd split a query into N independent sub-questions, fire N agent loops concurrently, and merge their results. In blooming insights, the Pipeline band is sequential and forced to be so by a typed data dependency: `recommendation.propose(anomaly, diagnosis, hooks)` literally requires the diagnosis as input. The diagram below shows the parallel-fan-out topology on top and blooming insights' sequential pipeline underneath for contrast.

```
  Zoom out — where parallel fan-out WOULD live

  ┌─ Pipeline coordinator ──────────────────────────┐  ← we are here
  │  ★ PARALLEL FAN-OUT shape (★ THIS ★, absent):     │
  │       split                                       │
  │    ┌────┼────┬────┬────┐                          │
  │    ▼    ▼    ▼    ▼    ▼                          │
  │   [A]  [B]  [C]  [D]  [E]   (concurrent agents)   │
  │    └────┴────┴────┴────┘                          │
  │              ▼ merge                              │
  │  ── absent in blooming insights ──                │
  │                                                   │
  │  blooming insights' actual shape (sequential):    │
  │    monitoring ─► diagnostic ─► recommendation     │
  │    (typed handoff forces order — Diagnosis is a   │
  │     required argument to propose())               │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  workers identical either way                     │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does parallelism between agents save latency without sacrificing correctness, and when does it just multiply costs? The latency win is real only when the sub-jobs are *genuinely* independent; the cost win only when parallelism is bounded against provider rate limits. blooming insights' sub-jobs are NOT independent (the typed `Diagnosis` enforces a dependency), so fan-out doesn't apply to the current flow. Below, you'll see where fan-out fits, the silent failure mode of fake-independence, and the future query shape that would earn the topology.

---

## Structure pass

**Layers.** Parallel fan-out would need four layers: the **Splitter** (decomposes the request into N independent sub-questions — deterministic or LLM-driven), the **Concurrent workers** (N agent loops running simultaneously), the **Merger** (combines results — function call or another agent), and a **Concurrency-backpressure layer** sitting alongside (enforces N-at-a-time against provider rate limits). In blooming insights none of these exist for the analyst flow; what occupies the Pipeline coordinator band is the sequential pipeline (`monitoring → diagnostic → recommendation`) with a typed `Diagnosis` data-dependency enforcing the order.

**Axis: control.** Who decides which sub-jobs run, in what order, and against what concurrency budget? This is the right axis because fan-out is fundamentally about *placing concurrency decisions* — splitting, scheduling, merging — and each of those is a control-flow choice. Cost is the killing argument in this codebase (the ~1 req/s MCP rate limit means wide concurrency just serializes again, with extra coordination tax), but cost is the *consequence* of letting control fan out without a backpressure layer. Control is upstream.

**Seams.** Two seams are load-bearing in the WOULD-BE shape. Seam 1 sits between the Splitter and the Concurrent workers — control flips from CODE (or MODEL) deciding the split, to CODE managing N parallel executions. Seam 2 sits between the Concurrent workers and the Merger — control flips from N-workers-with-results back to a single point that aggregates. Seam 2 is the load-bearing one because that's where partial failures get handled (one worker errors, the merger still has to produce something) and where the *fake independence* failure mode hides (the merger silently combines outputs that needed to talk to each other). In blooming insights both seams are absent because the typed `Diagnosis` enforces sequential dependency at the Pipeline band; there's nothing to split.

```
  Structure pass — Parallel fan-out (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Splitter (decomposes into N sub-questions)    │
  │  Concurrent workers (N agent loops)            │
  │  Merger (aggregates results)                   │
  │  Concurrency-backpressure (caps N for limits)  │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides what runs in parallel    │
  │           and against what budget?             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Splitter ↔ Concurrent workers         │
  │          (single decision → fan-out)           │
  │  Seam 2: Workers ↔ Merger                      │
  │          (N results → 1) ★ load-bearing —      │
  │          partial failure + fake-independence   │
  │          hide here                             │
  │  In this repo: typed Diagnosis dependency      │
  │  prevents the fan-out from existing            │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the fan-out mechanics, the silent fake-independence failure mode, and the future query shape that would earn the topology.

---

## How it works

**The mental model: `Promise.all()` with a merge.** Each promise is an agent; the merge is either a function call (deterministic) or another agent (when the merge itself needs reasoning).

```
Parallel fan-out in one picture

  user question
       │
       ▼
   ┌──────────────────────────┐
   │ split into N sub-questions│  (deterministic or by an LLM)
   └─────┬──────┬──────┬───────┘
         ▼      ▼      ▼
     ┌─────┐┌─────┐┌─────┐
     │ A   ││ B   ││ C   │     concurrent ReAct loops
     └──┬──┘└──┬──┘└──┬──┘
        └─────┼──────┘
              ▼
      ┌──────────────┐
      │ merge        │       function call OR agent
      └──────────────┘
              │
              ▼
          final answer
```

The strategy in plain English: **start all the work you can, wait for the slowest, then combine.** The win is latency; the constraint is that the work has to be genuinely independent — and that the upstream provider can absorb N concurrent calls without rate-limiting you back to sequential.

### Layer 1 — the split (decomposition)

The technical thing: a *deterministic decomposition* (code splits the user request into N sub-jobs) or an *LLM decomposition* (a planner agent reads the request and emits an array of sub-tasks).

If you're coming from frontend, deterministic decomposition is "I know I always need users + orders + products to render the page, so I write `Promise.all([getUsers, getOrders, getProducts])` in code." LLM decomposition is "the user typed a free-form question, and an LLM reads it and emits the list of fetches that answer it." The first is cheap and predictable; the second is adaptive but pays a model-call cost for the planning turn.

```
Two decomposition strategies

  Deterministic                       LLM decomposition
  ────────────────────                ────────────────────────
  the SPLIT is in code                a planner agent reads the
   (always the same N jobs)            request and emits sub-jobs
  free, predictable                    +1 LLM call per request
  works when the user                  works when the user request
   request shape is fixed               is open-ended
```

The practical consequence: which split you use determines whether fan-out is "free" or "costs a planner turn." For a fixed UI like "give me a 30-day overview across 4 metrics," deterministic split is fine — the four sub-jobs are always the same. For "ask blooming insights anything," the planner has to decide what sub-questions to fan out.

The condition under which this works: the sub-jobs really *are* independent. If sub-job B depends on sub-job A's output, you have a pipeline, not a fan-out — and parallelizing them either doesn't work (B can't start) or wastes work (B runs without context and the result gets thrown away).

### Layer 2 — concurrency control (the rate-limit reality)

The technical thing: a *semaphore* that caps how many workers run at once. `N` is the cap. The first `N` workers run immediately; the next ones queue; as each worker finishes, the next queued one starts.

If you're coming from frontend, this is `Promise.all()` with a concurrency limit — the same thing you reach for when you have 200 independent fetches but don't want to open 200 connections at once. Libraries: `p-limit`, `bluebird.map(..., { concurrency: N })`.

```
The semaphore

  Supervisor says: "fan out 12 workers"
       │
       ▼
  ┌────────────────────────────────────────┐
  │ Semaphore (concurrency cap N=4)        │
  │   slots: [worker1][worker2][worker3]   │
  │          [worker4]                     │
  │   queue: [w5, w6, w7, w8, w9, w10,     │
  │           w11, w12]                    │
  │                                        │
  │  as a slot frees, the next worker      │
  │  starts                                │
  └────────────────────────────────────────┘
       │
       ▼
  Provider sees at most 4 concurrent calls
```

The practical consequence: the cap is what prevents fan-out from melting your provider rate limit. Without it, fan-out of 20 workers slams the provider with 20 concurrent requests; you get 429s, retries, and end up *slower* than sequential.

The condition under which this works: the cap has to match the provider's rate limit divided by per-call duration. In blooming insights' case, MCP is ~1 req/s (the MCP client enforces a ~1.1s spacer between calls). Each agent loop makes multiple MCP calls. Even N=2 concurrent agent loops would serialize their MCP calls through the spacer — you'd get sequential MCP throughput with the overhead of concurrent agent loops.

### Layer 3 — the merge (function call vs agent)

The technical thing: a *combiner* that takes the workers' outputs and produces the final answer. Two flavors: a function call (deterministic merge — e.g. `[...results]` or `Object.assign(...results)`) or an LLM merge (a final agent that reads all worker outputs and writes a synthesis paragraph).

If you're coming from frontend, function-call merge is `Promise.all([...]).then(([a, b, c]) => render(a, b, c))` — your render function combines. LLM merge is `Promise.all([...]).then(([a, b, c]) => llm.summarize([a, b, c]))` — you outsource the combination to a model.

```
Two merge strategies

  Function-call merge              LLM merge
  ─────────────────────────────    ─────────────────────────────
  combine outputs in code           one more agent reads all
   ({ a, b, c } or [a, b, c])       worker outputs and writes
  free, deterministic                a synthesis
  works when outputs combine        +1 LLM call (~1–3s)
   cleanly                          works when synthesis itself
                                     needs reasoning
                                    risk: fabrication, averaging
                                     contradictions
```

The practical consequence: LLM merge is where fan-out earns most of its "agentic" reputation — it's the multi-agent shape that *feels* most like multiple agents collaborating. But the merge step is also where the worst failure mode lives: contradictions averaged into a confident-sounding wrong answer. Function-call merge sidesteps this by refusing to merge — you just hand the worker outputs back as a list and let the caller decide.

The condition under which function-call merge works: the worker outputs are *additive* (each worker's output is one piece of the final answer, not an opinion on the same question). When they're opinionated (e.g. three workers each propose recommendations and you need ONE final list), you either need a deterministic ranker or an LLM merge.

### Phase A vs Phase B — where fan-out would fit in this codebase

Right now there's no fan-out anywhere. The query agent handles one free-form question end-to-end; the pipeline is sequential. Here's where the breakpoint would land.

```
        Now (no fan-out)                If a multi-domain query arrived
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│ free-form ?q=…                  │  │ ?q="give me 30-day funnel +      │ ←
│   ▼                             │  │  conversion + retention +       │
│ classify_intent (cheap, ~150ms) │  │  segments overview"             │
│   ▼                             │  │   ▼                              │
│ query agent.answer(q, intent)   │  │ classify_intent → MULTI-DOMAIN   │
│   ReAct loop (1 stage, 1 budget)│  │   ▼                              │
│   sequential MCP calls          │  │ fan out 4 sub-agents             │ ←
│   ▼                             │  │   (one per domain)               │
│ single answer                   │  │   semaphore N=2 (MCP rate limit) │
│                                 │  │   ▼                              │
│                                 │  │ merge agent synthesizes one      │ ←
│                                 │  │  cross-domain overview           │
└─────────────────────────────────┘  └─────────────────────────────────┘
   the query agent today is single-domain; the breakpoint is
   when one user request spans multiple independent domains
```

*Now:* the query agent processes one question at a time. If the question spans multiple domains (e.g. "compare funnel AND conversion AND retention"), the agent serializes the analytics calls inside its single loop — it makes 4 sequential tool calls under the ~1.1s spacer, totaling ~5 seconds for the data alone.

*If a multi-domain query arrived:* the classifier (or the planner agent) would emit a list of 4 sub-questions; 4 sub-agents would fan out, each running their own ReAct loop for their domain; a merge agent (or a function-call merge with a synthesis prompt) would combine them. The latency win: ~max(t1, t2, t3, t4) ≈ 2 seconds per agent + merge ≈ ~3 seconds total, vs ~5+ sequential. The cost: 4 worker LLM loops + 1 merge LLM call instead of 1 worker loop.

The takeaway: **fan-out earns its overhead when the per-domain latency × N exceeds the parallel max × N × concurrency-overhead.** That's a quantitative breakpoint. Under the current MCP rate limit, N=2 with two-domain queries is plausibly worth it; N=8 isn't.

This is what people mean by "fan out when independent, sequential when dependent, capped by the provider's rate limit either way." Fan-out isn't a free lunch — it's a tradeoff between latency and cost, gated by upstream concurrency tolerance.

The full picture is below.

---

## Parallel fan-out — diagram

```
Parallel fan-out — full picture

  ┌─ DECOMPOSITION (the split) ───────────────────────────────────┐
  │                                                                │
  │  user request                                                  │
  │       │                                                        │
  │       ▼                                                        │
  │   ┌──────────────────────────────────────┐                     │
  │   │ either: code splits (deterministic)  │                     │
  │   │ or:     LLM planner splits (adaptive)│                     │
  │   └────┬─────────┬──────────┬────────────┘                     │
  │        ▼         ▼          ▼                                  │
  │      sub-job   sub-job    sub-job                              │
  │       A         B          C                                   │
  └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ CONCURRENCY CONTROL (the semaphore) ─────────────────────────┐
  │                                                                │
  │   ┌─────────────────────────────────┐                          │
  │   │ Semaphore (cap N)               │                          │
  │   │  pop up to N concurrent         │                          │
  │   │  queue the rest                 │                          │
  │   │                                 │                          │
  │   │  set N = provider rate limit /  │                          │
  │   │           per-call duration     │                          │
  │   └─────────────────────────────────┘                          │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ WORKERS (concurrent ReAct loops) ────────────────────────────┐
  │                                                                │
  │      ┌────────┐  ┌────────┐  ┌────────┐                       │
  │      │worker A│  │worker B│  │worker C│  ... up to N at a time│
  │      │ ReAct  │  │ ReAct  │  │ ReAct  │                       │
  │      └────┬───┘  └────┬───┘  └────┬───┘                       │
  │           └───────────┼──────────┘                            │
  │                       ▼                                       │
  └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ MERGE (the combine) ─────────────────────────────────────────┐
  │                                                                │
  │   ┌─────────────────────────────────┐                          │
  │   │ either: function-call merge     │                          │
  │   │   (deterministic combine)       │                          │
  │   │ or:     LLM merge agent         │                          │
  │   │   (synthesis with reasoning)    │                          │
  │   └─────────────────────────────────┘                          │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         final answer

  blooming insights: NOT YET IMPLEMENTED — the pipeline is
  sequential, the query agent is single-domain, and the ~1 req/s
  MCP rate limit means N>1 fan-out would serialize at the MCP
  layer anyway. See the orchestration system-design templates
  for the refactor.
```

---

## Implementation in codebase

**Not yet implemented.**

blooming insights does not fan out. The pipeline is strictly sequential (monitoring → diagnostic → recommendation), user-gated between stages, and the recommendation stage's data dependency on the diagnosis is enforced by the function signature `propose(anomaly, diagnosis, hooks)`. The free-form query path also runs a single QueryAgent end-to-end, not a fan-out of sub-queries.

The honest sentence: **the codebase doesn't fan out today, and the ~1 req/s MCP rate limit (`connect.ts` L92, `minIntervalMs: 1100`) makes wide concurrency a poor fit even if it did** — any fan-out would have to serialize through the same MCP spacer at the tool-call layer, which collapses the latency win back toward sequential.

For the refactor: see `../06-orchestration-system-design-templates/` (the "multi-agent research assistant" template uses fan-out as the standard architecture) and `../05-production-serving/02-fan-out-backpressure.md` (the concurrency-cap mechanic that makes fan-out safe).

**The constraint that makes wide fan-out impractical today**
**File:** `lib/mcp/connect.ts`
**Function / class:** the McpClient constructor options
**Line range:** L92 — `minIntervalMs: 1100` (the per-MCP-call spacer)

**The single-domain path that would become fan-out at the breakpoint**
**File:** `lib/agents/query.ts`
**Function / class:** `QueryAgent.answer()`
**Line range:** L41–L42 (the current `maxToolCalls: 6` budget for one agent handling the whole question)

```
shape (what a future fan-out would look like, NOT current code):

  // hypothetical: in route.ts query branch
  const intent = await classifyIntent(anthropic, q);
  if (intent === 'multi-domain') {
    const subQuestions = await splitIntoSubQuestions(q);  // code or LLM
    const results = await semaphoreFanOut(
      subQuestions,
      async (sq) => new QueryAgent(...).answer(sq, classifyIntent(sq)),
      { concurrency: 2 }   // capped by MCP rate limit
    );
    const merged = await mergeAgent.synthesize(q, results);  // or fn-call merge
    return merged;
  }
  // today: single QueryAgent end-to-end
```

---

## Elaborate

### Where this pattern comes from

Fan-out fan-in is older than computing as a discipline — every map-reduce job is fan-out fan-in, every parallel test runner is fan-out fan-in, every `Promise.all` is a baby fan-out. The agentic version got its current framing from Anthropic's "Building Effective Agents" (2024) under the name "parallelization," which named two sub-modes: *sectioning* (a task is broken into independent subtasks that run in parallel) and *voting* (the same task is run N times for diversity, then results are aggregated). LangGraph's "Send" API and OpenAI Agents SDK's parallel handoffs both ship fan-out as a first-class primitive.

### The deeper principle

**Latency parallelism is free only when the work is genuinely independent AND the upstream can absorb the concurrency.** Both halves are constraints. Ignoring either turns "fan-out" into "fan-out followed by serialization at the bottleneck," which costs the same wall-clock time as sequential and pays N× the LLM bill.

```
Two conditions for fan-out to pay off

  ┌──────────────────────────────────┐
  │ 1. sub-jobs are INDEPENDENT       │
  │    (B doesn't need A's output)   │
  └──────────────────────────────────┘
  ┌──────────────────────────────────┐
  │ 2. upstream can ABSORB N         │
  │    concurrent calls without       │
  │    rate-limiting you back to     │
  │    sequential                     │
  └──────────────────────────────────┘

  fail (1) → wasted work (B runs without context, discarded)
  fail (2) → wall-clock identical to sequential, pay N× LLM cost
```

This is the same principle behind `Promise.all` with concurrency caps — and the same reason React's concurrent mode introduces transitions: parallelism is a strategy with a cost ceiling, not a free axis.

### Where this breaks down

Fan-out breaks when the sub-jobs *secretly* depend on each other — when the planner doesn't realize that sub-job B needs sub-job A's output, fans them out, B runs without context, and the merger combines a context-less B output into the answer. This is the classic "fan-out hides the dependency" failure mode.

It also breaks when the merge is an LLM and the worker outputs contradict each other — the LLM merger tends to *average* contradictions into a confident-sounding compromise rather than surfacing the conflict. The mitigation is to validate worker outputs against a schema before synthesis (cross-reference: `./09-coordination-failure-modes.md`'s "synthesis failure" entry).

### What to explore next
- `../05-production-serving/02-fan-out-backpressure.md` → the concurrency-cap mechanic that makes fan-out safe under rate limits
- `./03-sequential-pipeline.md` → the shape fan-out becomes when sub-jobs are dependent (this codebase)
- `./09-coordination-failure-modes.md` → "tool-call cascade" and "synthesis failure" — both fan-out-amplified
- `../06-orchestration-system-design-templates/` → the "multi-agent research assistant" template, which uses fan-out as standard

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "why don't you fan out" they're testing whether you can defend an *absence* — whether you considered parallelism and chose against it, or didn't reach for it. The strong signal is naming the constraints (data dependency + rate limit) that make fan-out worse than sequential today. The weak signal is calling fan-out "more complex" without naming the specific complexity (semaphores, merge fabrication, hidden-dependency failures).

### Likely questions

[mid] Q: Could the pipeline be parallel?

A: No — the recommendation agent's signature literally takes the diagnosis as a required argument: `propose(anomaly, diagnosis, hooks)`. Recommendation can't start before diagnostic finishes. The pipeline is sequential by data dependency, not by preference. The signature is the contract.

Diagram:
```
  diagnostic.investigate(): Promise<Diagnosis>
                                  │ this output…
                                  ▼
  recommendation.propose(_, diagnosis, _)
                            ▲
                            │ …is required input
   parallelism here would mean running propose
   without a diagnosis — TypeScript won't compile it,
   and the model would have nothing to propose from.
```

[senior] Q: What about fanning out inside a single agent's loop — e.g. the QueryAgent making 4 EQL calls in parallel?

A: That would help on multi-domain queries (funnel + conversion + retention + segments in one question), but two constraints block it today. First, the MCP client enforces ~1.1s spacing between calls (`connect.ts` L92, `minIntervalMs: 1100`) — that's a rate limit on the MCP server, not on the agent. Even if I fanned out 4 concurrent EQL calls from the agent, the MCP client would serialize them through the 1.1s spacer. So the wall-clock win collapses to "sequential MCP calls with the overhead of concurrent agent code." Second, the QueryAgent today handles one question at a time end-to-end; a multi-domain split would need a planner stage to decompose the question, which is itself an LLM call. The fan-out earns its overhead only when the per-domain latency × N exceeds the parallel max × N × (1 + planner_overhead) — a quantitative breakpoint that isn't met today.

Diagram:
```
  What I'd need to change for fan-out to pay off:

  ┌─ 1. relax the MCP rate limit ──┐
  │   (~1 req/s → ~3–5 req/s)      │ ← required, currently fixed
  └────────────────────────────────┘
  ┌─ 2. add a planner / splitter ──┐
  │   (or a deterministic split)   │ ← +1 LLM call OR static code
  └────────────────────────────────┘
  ┌─ 3. add a semaphore (N=2 or 3) ┐
  │   to cap concurrency           │ ← protects the new rate limit
  └────────────────────────────────┘
  ┌─ 4. add a merge step           ┐
  │   (function-call or LLM)       │ ← combine sub-domain results
  └────────────────────────────────┘
```

[arch] Q: At 100x usage, would you reach for fan-out?

A: Only for specific paths. The investigation pipeline stays sequential — the data dependency between diagnostic and recommendation doesn't disappear at any scale. The QueryAgent's multi-domain path becomes worth fanning out at some volume × multi-domain-query-frequency × relaxed-MCP-rate threshold. But the dominant scaling fix at 100x isn't fan-out within one request — it's *backpressure across requests*: limiting how many concurrent investigations hit the MCP server at once, regardless of whether each investigation is sequential or fanned-out. Fan-out within a request and backpressure across requests are orthogonal — and at high load, the across-request constraint matters more. See `../05-production-serving/02-fan-out-backpressure.md`.

Diagram:
```
  Two axes of concurrency

  ┌──────────────────────────────────────────────┐
  │   WITHIN a request (fan-out)                  │
  │   ┌────┐┌────┐┌────┐                          │
  │   │ A  ││ B  ││ C  │ workers in parallel       │
  │   └────┘└────┘└────┘                          │
  └──────────────────────────────────────────────┘
                  ×
  ┌──────────────────────────────────────────────┐
  │   ACROSS requests (concurrent investigations) │
  │   ┌─request 1─┐ ┌─request 2─┐ ┌─request 3─┐  │
  │   │ pipeline  │ │ pipeline  │ │ pipeline  │  │
  │   └───────────┘ └───────────┘ └───────────┘  │
  └──────────────────────────────────────────────┘

  At 100x, the second axis dominates. Backpressure first;
  fan-out only for multi-domain paths that earn it.
```

### The question candidates always dodge

Q: If you're not fanning out, you're leaving wall-clock latency on the table. Why is "sequential is fine" the right answer for an agentic product?

A: Because wall-clock latency *isn't* the constraint that hurts users here. The two-step UX is gated by the user clicking "see recommendations" — there's a human-in-the-loop pause between diagnostic and recommendation that dwarfs any sequential vs parallel difference. The diagnostic step itself takes ~5–7 seconds, which fits well under "the user reads the result and decides." If diagnostic dropped to 3 seconds via fan-out, the user still spends 5–10 seconds reading before clicking — the parallelism doesn't reach the user. Where it WOULD matter is the free-form query path, where the user is waiting for one answer. But that path is single-domain today (the classifier in `intent.ts` routes to one of five intents), so there's nothing to fan out. The honest version: fan-out is a latency optimization that doesn't move the needle until the user-facing latency budget is the binding constraint, and right now the user-facing constraint is "did the diagnosis show me something useful?" — a quality question, not a latency one. I'd reach for fan-out the day quality is solid and 30+ seconds of multi-domain query latency was the complaint.

Diagram:
```
What fan-out optimizes vs what the user cares about

  ┌────────────────────────────┐  ┌─────────────────────────────┐
  │ Fan-out optimizes:         │  │ User-facing constraint here: │
  │  wall-clock latency        │  │  "is the diagnosis useful?"   │
  │  WITHIN one request,       │  │  (quality, not latency)       │
  │   when sub-jobs are        │  │                                │
  │   independent              │  │  + the gate between step 2    │
  │                            │  │   and step 3 is a USER click  │
  │                            │  │   (5–10s of human time anyway)│
  └────────────────────────────┘  └─────────────────────────────┘

  Until quality is solid, fan-out optimizes
  the wrong axis.
```

### One-line anchors

- "The pipeline is sequential because the function signature requires it — `propose(anomaly, diagnosis, hooks)` enforces the order."
- "Fan-out's win is `max` instead of `sum`, but only when sub-jobs are independent AND the upstream can absorb N concurrent calls."
- "Under our ~1 req/s MCP limit, a fan-out semaphore cap of N=1–2 collapses the latency win back toward sequential — it's a non-win today."
- "The breakpoint is multi-domain queries in one request, AND a relaxed rate limit — not a vibes-based 'let's go parallel.'"

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the fan-out shape from memory: a split at the top, N concurrent workers, a merge at the bottom. Then annotate where a semaphore cap goes and what its value would be in blooming insights given the MCP rate limit.

Open the file. Compare.

✓ Pass: you drew the split-workers-merge shape, named the semaphore between split and workers, and put N=1–2 given the ~1 req/s MCP limit
✗ Fail: re-read How it works Layers 1–2 and the diagram, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who asked "why don't you parallelize the pipeline?" — under 90 seconds, no notes.

Checkpoints — did you:
- Name the data dependency (recommendation needs diagnosis as a function arg)?
- Name the rate-limit constraint (~1 req/s MCP spacing) and why it collapses fan-out's win?
- Say where fan-out *would* fit (multi-domain QueryAgent path)?
- Name the breakpoint (multi-domain queries + relaxed rate limit)?

If you skipped any: you described why it's not implemented, you didn't defend the absence.

### Level 3 — Apply it to a new scenario

A product manager wants the QueryAgent to handle multi-domain queries like "give me the funnel drop-off, the conversion rate, the retention curve, AND the segment breakdown for the last 30 days" — and wants the answer in under 6 seconds.

Without looking at the file: how would you decompose the query? Where would you put the semaphore, and what value of N? How would you merge — function call or LLM? What changes do you need to the MCP rate limit for the latency target to be achievable?

Write your answer (3–5 sentences). Then open `lib/mcp/connect.ts` L92 and `lib/agents/query.ts` L41–L42 and verify which constraints would have to relax.

### Level 4 — Defend the decision you'd change

"If you were starting this project today and you knew the dominant user behavior would be multi-domain queries (not anomaly investigation), would you still build the pipeline as sequential? Or would you architect the QueryAgent as a fan-out from day one? What's the cost of the wrong call in either direction — over-built fan-out for single-domain queries, or sequential when multi-domain dominates?"

Reference the code: `lib/agents/query.ts` L41–L42 (current single-agent shape), `lib/mcp/connect.ts` L92 (the rate-limit constraint), `app/api/agent/route.ts` L210–L218 (the query branch in the route).

### Quick check — code reference test

Without opening any files:
- Why doesn't blooming insights fan out the pipeline stages? (One sentence — the signature.)
- What's the MCP rate limit, and where is it set?
- Which agent would be the first to benefit from fan-out if the rate limit were relaxed?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `./03-sequential-pipeline.md` · → `./01-when-not-to-go-multi-agent.md` · → backpressure: `../05-production-serving/02-fan-out-backpressure.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
