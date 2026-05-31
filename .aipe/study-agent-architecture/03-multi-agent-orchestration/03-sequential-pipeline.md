# Sequential pipeline (agents as pipeline stages)

**Industry name(s):** Sequential pipeline, prompt chain, agent-as-pipeline-stage, agentic chain
**Type:** Industry standard · Language-agnostic

> The primary topology in blooming insights: monitoring → diagnostic → recommendation, with the typed `Diagnosis` handed step-to-step as a structured message. The user gates the transition between stages. Each stage is a ReAct loop with its own tool subset and budget — but the order between them is fixed and owned by code.

**See also:** → `./01-when-not-to-go-multi-agent.md` · → `./02-supervisor-worker.md` · → `./08-shared-state-and-message-passing.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → client handoff: `../../study-system-design-dsa/01-system-design/07-client-stream-handoff.md` · → chain/agent boundary: `../01-reasoning-patterns/01-chains-vs-agents.md`

---

## Why care

### Move 1 — the scenario (lead with the shape)

```
The sequential pipeline shape

  ┌─────────┐  draft  ┌─────────┐ reviewed ┌─────────┐
  │ Stage A │ ──────► │ Stage B │ ───────► │ Stage C │
  │ (find)  │         │(explain)│          │(propose)│
  └─────────┘         └─────────┘          └─────────┘

  output of one = input of next; order is fixed
```

You've written this code a thousand times:

```
const user = await fetchUser(id);
const orders = await loadOrders(user);
const summary = await summarize(orders);
return render(summary);
```

A `.then()` chain of single-purpose functions. Each step takes the previous step's output and produces the next step's input. The order is fixed (you can't summarize before you've loaded orders). The whole thing is a pipeline.

Now picture the same shape, except each function is an *agent* — a ReAct loop with its own prompt, its own tool subset, its own budget. The chain shape stays the same; the cells of the chain just got smarter inside.

### Move 2 — name the question

That second shape — a `.then()` chain where each function is an agent — is what sequential pipeline names. Not the diffing between agents, not the parallelism (there is none), just the order. The question this file answers: **when does it make sense to have agents as pipeline stages, versus one big agent that does everything, versus parallel workers?**

Sequential pipeline is the answer when the *sub-jobs are real* (different prompts, different tool needs, different output schemas) AND the *order is fixed* (each stage needs the previous one's output to start). Both halves matter.

### Move 3 — why answering that question matters

**Why you need to answer that question at all:** because the alternative shapes (one mega-agent, parallel fan-out) fail in opposite ways, and the failure cost is highest when you pick the wrong one.

One mega-agent with all tools fails by *responsibility-blending*: one prompt has to handle detection AND diagnosis AND recommendation; one tool budget has to cover all three; the model mixes outputs. Parallel fan-out fails when the sub-jobs aren't actually independent — if stage B needs stage A's diagnosis, running them in parallel just means B runs without context and you throw its work away.

In this codebase: the diagnostic agent's typed `Diagnosis` is literally an input to the recommendation agent's `propose(anomaly, diagnosis, hooks)` call. The recommendation agent cannot start without it. That data dependency is the constraint that forces sequential — not preference, not aesthetics. The order has to be sequential because the data flow is sequential.

### Move 4 — concrete before/after

One mega-agent with everything:
- One prompt, ~20 tools, one 12-iteration budget for detect + diagnose + recommend combined
- The model has to decide every turn: "am I detecting, diagnosing, or recommending?" — and the answer drifts
- Tool budget burned 8 turns on detection, only 4 left for diagnosis + recommendation
- Output schema is a soup — sometimes a diagnosis, sometimes a recommendation list, sometimes both, sometimes neither

Sequential pipeline (this codebase):
- Three prompts, each ~5–8 tools, each with its own budget (6/6/4 turns)
- Diagnostic agent runs with diagnostic prompt + diagnostic tools — no detection, no recommendation
- Diagnosis returned as typed `Diagnosis` object — a clean handoff
- Recommendation agent gets the diagnosis as an input; its prompt is focused on action proposals
- Each stage's output is schema-validated before becoming the next stage's input

### Move 5 — one-line summary

A sequential pipeline is a `.then()` chain where each function is an agent — same shape as `a().then(b).then(c)`, except `a` and `b` and `c` are ReAct loops. blooming insights uses this for `monitoring → diagnostic → recommendation`, with the typed `Diagnosis` as the message handed step-to-step. Here's how the mechanics work.

---

## How it works

**The mental model: a `.then()` chain where each link is an agent.** The order between links is owned by code (the route file's pipeline). What each link *does* — which tools, how many turns, when to stop — is owned by the model. Two layers of control, with the boundary cleanly drawn between them.

```
The sequential pipeline in this codebase

  monitoring             diagnostic              recommendation
  agent                  agent                   agent
  ┌──────────┐           ┌──────────┐            ┌──────────┐
  │ ReAct    │  Anomaly  │ ReAct    │ Diagnosis  │ ReAct    │
  │ loop     │ ────────► │ loop     │ ─────────► │ loop     │
  │ (6 tools)│ (typed)   │ (6 tools)│ (typed)    │ (4 tools)│
  └──────────┘           └──────────┘            └──────────┘
       ▲                      ▲                       ▲
       │                      │                       │
       └──────────────────────┴───────────────────────┘
              CODE owns the order
              (app/api/agent/route.ts L224–L249)
              + (cross-request handoff via sessionStorage)
```

The strategy in plain English: **fix the order where you know it, isolate the work where you don't.** The order is fixed because the data flow is sequential (each stage's input is the previous stage's output). The work inside each stage is isolated because each stage has its own prompt, its own tool subset, and its own iteration budget.

### Isolate the kernel

A sequential pipeline of agents has an irreducible kernel: four pieces that make it a pipeline, not just calls in a row.

```
stage_N(input) → TypedMessage      ←  the shape is required
                      │
                      ▼  CARRIER (function arg | sessionStorage+URL)
                      │
stage_(N+1)(input, TypedMessage)   ←  consumes the typed value as input
                      │
                      ▼  per-stage isolation: own tools + own budget
                      │
                  next stage…       ←  CODE picks who runs next, not an LLM
```

Four load-bearing pieces:

1. **Typed inter-stage message** — a concrete schema (here: `Diagnosis` with `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers` / `confidence` / `timeSeries`, `lib/mcp/types.ts`). Stage N+1 takes it as a typed argument; the type system enforces that "stage N's output is a valid stage N+1 input."
2. **A handoff carrier** — *something* that moves the typed value from stage N to stage N+1. Two carriers ship in this repo: a function argument when stages run in the same request, a `sessionStorage`-write-plus-URL-param-read when they don't. Same message, two carriers.
3. **A gate that picks who runs next** — `app/api/agent/route.ts` reads `?step=diagnose|recommend` and picks the lead agent. Code, not an LLM. The Combined Run path makes this gate automatic ("after diagnose, recommend"); the Split Steps path makes it user-driven (the user clicks "see recommendations").
4. **Per-stage tool subset + budget** — each stage gets only the tools it needs (`lib/mcp/tools.ts`) and a budget calibrated to its job (monitoring 6, diagnostic 6, recommendation 4, query 6). The budget IS the per-stage isolation.

The wire-level mechanics — what the `Diagnosis` object looks like, how `sessionStorage['bi:diag:<id>']` is keyed, what `parseDiagnosis` validates, how the route's `if (step === 'diagnose')` ladder dispatches — are below. The kernel is what makes this a pipeline; everything else is hardening.

---

### Name each part by what breaks when removed

Each kernel piece is here because something specific breaks if you drop it.

```
Removed                            What breaks
────────────────────────────       ─────────────────────────────────────
typed message schema               Stages can only pass prose. The
                                   recommendation agent has to re-read
                                   the diagnostic agent's text output and
                                   re-derive the structure. Two stages
                                   stop composing — they become parallel
                                   solvers of the same problem.

handoff carrier                    The pipeline can't run. In-process:
                                   no way to thread the return value
                                   through `start()`. Across requests:
                                   no way to carry the diagnosis to the
                                   recommend step at all — Split Steps
                                   becomes impossible.

the gate                           Combined Run: the next stage fires
                                   unsolicited on every diagnose, doubling
                                   spend even when the user didn't want a
                                   recommendation. Split Steps: the next
                                   stage never fires, because nothing
                                   tells the route which agent to run.
                                   "Deterministic orchestration" requires
                                   code making the decision; absence of
                                   the gate means *nothing* is making it.

per-stage tools + budget           Recommendation can call analytics
                                   tools meant for diagnostic; it
                                   re-investigates from scratch instead
                                   of using the handed-over Diagnosis.
                                   The "pass the typed message forward"
                                   gain evaporates. Budget compounds
                                   across stages with no isolation — one
                                   slow stage burns the next stage's
                                   allotment too.
```

The kernel composes: the typed message *carries* the work forward, the carrier *moves* it across the boundary, the gate *decides* what runs next, and per-stage isolation *protects* one stage from another's spend. Drop any one and the pipeline reverts to "uncoordinated agents in sequence."

---

### Separate skeleton from optional hardening

The kernel is the minimum that makes this a pipeline. Everything around it is hardening — useful, but layered on. The interesting move is that *two of the hardening choices coexist*: the codebase ships *both* carriers, because the same pipeline runs in two modes.

```
SKELETON (required to be a pipeline)        HARDENING (some chosen, some not)
─────────────────────────────────────       ──────────────────────────────────
Diagnosis / Anomaly typed schemas           ┌ Carrier #1: function argument
  (lib/mcp/types.ts)                        │   in-process (PRESENT — Combined
diagnostic.ts: investigate() →              │   Run mode for capture + demo)
  Promise<Diagnosis>                        ├ Carrier #2: sessionStorage +
recommendation.ts: propose(anomaly,         │   URL param across requests
  diagnosis, …) consuming the typed Dx      │   (PRESENT — Split Steps mode,
route picks the next agent from ?step       │   the production UX)
per-stage maxToolCalls + tool subsets       ├ saveInvestigation +
                                            │   filterByStep replay so the
                                            │   captured event log replays
                                            │   in either mode (PRESENT —
                                            │   the demo path)
                                            ├ streaming each stage's
                                            │   intermediate output (the
                                            │   `diagnosis` event) so the
                                            │   UI renders before the next
                                            │   stage runs (PRESENT)
                                            ├ user gate vs automatic gate
                                            │   (BOTH PRESENT — user gate
                                            │   in Split Steps, automatic
                                            │   in Combined Run; the gate's
                                            │   *existence* is the kernel,
                                            │   *who/what* triggers it is
                                            │   hardening)
                                            ├ an LLM supervisor that picks
                                            │   the next stage from model
                                            │   judgment instead of route
                                            │   code (ABSENT — deliberate;
                                            │   see `02-supervisor-worker.md`)
                                            └ parallel fan-out across peer
                                                stages (ABSENT — stages are
                                                inherently sequential here;
                                                see `04-parallel-fan-out.md`)
```

The takeaway is **the pipeline is one shape with two carriers.** In-process: a function call (`const dx = await diagAgent.investigate(...); await recAgent.propose(inv, dx, ...)`). Across requests: a `sessionStorage` write plus a URL-param read. The *typed message* — `Diagnosis` — is the invariant. The carrier is hardening that varies by mode.

This is what people mean by "agents as pipeline stages": agents that ship typed messages between themselves the way functions ship typed return values, with code owning the order.


The full picture is below.

---

## Sequential pipeline — diagram

```
Sequential pipeline — the full picture in this codebase

  ┌─ CODE LAYER (order owner) ────────────────────────────────────────────┐
  │  app/api/agent/route.ts L224–L249                                     │
  │                                                                       │
  │  if step === 'recommend':                                             │
  │     diagnosis = parseDiagnosis(URL ?diagnosis=…)   ◄── handoff in     │
  │  else:                                                                │
  │     diagnosis = await diagAgent.investigate(inv, hooksFor('diag'))   │
  │     send('diagnosis', diagnosis)                   ──► handoff out    │
  │                                                                       │
  │  if step !== 'diagnose':                                              │
  │     recs = await recAgent.propose(inv, diagnosis!, hooksFor('rec'))   │
  │     send('recommendation', …)                                         │
  └───────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ AGENT LAYER (each stage is a ReAct loop) ───────────────────────────┐
  │                                                                       │
  │  ┌─ Diagnostic stage ──┐         ┌─ Recommendation stage ──┐         │
  │  │ prompt: investigate │         │ prompt: propose actions  │         │
  │  │ tools: 6 analytics  │         │ tools: 4 feature-spec    │         │
  │  │ budget: maxTC=6     │         │ budget: maxTC=4          │         │
  │  │ output: Diagnosis   ├────────►│ input:  Diagnosis        │         │
  │  └─────────────────────┘         └──────────────────────────┘         │
  │       │                                  │                            │
  │       └──────► runAgentLoop ◄────────────┘                            │
  │              (lib/agents/base.ts L48–L176)                            │
  │              same loop primitive, different prompts/tools/budgets     │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
  ┌─ MESSAGE LAYER (the inter-stage contract) ───────────────────────────┐
  │  interface Diagnosis {                                                │
  │    conclusion: string;                                                │
  │    evidence: string[];                                                │
  │    hypothesesConsidered: { hypothesis; supported; reasoning }[];      │
  │    affectedCustomers?: { count; segmentDescription };                 │
  │    confidence?: 'high'|'medium'|'low';                                │
  │    timeSeries?: { day; value }[];                                     │
  │  }                                                                    │
  │  defined in lib/mcp/types.ts L95–L104                                 │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — the pipeline is the primary topology.**

**The pipeline order (code owns it)**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body
**Line range:** L224–L249 — STEP 2 diagnose (L231–L240), STEP 3 recommend (L244–L249), inter-stage handoff via `diagnosis` (L238, L247)

**The typed inter-stage message**
**File:** `lib/mcp/types.ts`
**Function / class:** `interface Diagnosis`
**Line range:** L95–L104

**The cross-request handoff (client side)**
**File:** `lib/hooks/useInvestigation.ts`
**Function / class:** the `case 'done':` block of the SSE handler
**Line range:** L138 (write) — `sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }))`

**The cross-request handoff (server side)**
**File:** `app/api/agent/route.ts`
**Function / class:** `parseDiagnosis()`
**Line range:** L86–L97 — validates that the handed-over object has `conclusion`, `evidence[]`, `hypothesesConsidered[]` before resuming the pipeline

**Per-stage budgets (the per-stage "size" of each pipeline link)**
**File:** `lib/agents/diagnostic.ts` L62 (`maxToolCalls: 6`), `lib/agents/recommendation.ts` L57 (`maxToolCalls: 4`), `lib/agents/monitoring.ts` L101 (`maxToolCalls: 6`)

**Demo replay filter (the same pipeline, sliced by step)**
**File:** `app/api/agent/route.ts`
**Function / class:** `filterByStep()`
**Line range:** L66–L84 — the cached combined run is filtered to just `diagnose` or just `recommend` events for replay

```
shape (not full impl):

  // route.ts — code owns the pipeline order
  if (step === 'recommend') {
    diagnosis = parseDiagnosis(diagnosisParam);  // resumed handoff
  } else {
    const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
    diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
    send({ type: 'diagnosis', diagnosis });      // emit to UI + persist
  }

  if (step !== 'diagnose') {
    const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
    const recs = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
    for (const r of recs) send({ type: 'recommendation', recommendation: r });
  }
```

---

## Elaborate

### Where this pattern comes from

Sequential pipelines pre-date LLMs by decades — every Unix pipeline (`ps | grep | awk`) is one. The LLM-pipeline version got its current framing from Anthropic's "Building Effective Agents" (2024), which named "prompt chaining" as the simplest agentic workflow: decompose a task into a fixed sequence of steps, where each LLM call processes the output of the previous one. The essay's key insight: when latency is acceptable and accuracy matters, decomposing into a chain trades a single complex prompt for several focused ones — and focused prompts measurably outperform combined ones.

### The deeper principle

**Pipelines work when the data dependency is sequential and the order is knowable.** Both halves matter. If the data dependency is sequential but the order isn't knowable (one stage might be skipped, another repeated), you need a state machine or a supervisor. If the order is knowable but the data dependency isn't sequential (sub-jobs are independent), you should fan out in parallel.

```
   sequential data dep + knowable order   → pipeline
   sequential data dep + unknowable order → supervisor / state machine
   independent sub-jobs + any order        → parallel fan-out
   peer interaction with no fixed order    → swarm / handoff
```

The pipeline isn't a compromise — it's the right shape when both conditions hold, and only when both conditions hold.

### Where this breaks down

The pipeline breaks when the data dependency starts to branch — e.g. when "the diagnosis might be inconclusive, so re-run with a deeper budget" introduces a back-edge that an `if`-ladder can express but a more complex branching pattern can't. At that point you're in graph orchestration (`./07-graph-orchestration.md`) territory.

It also breaks when latency becomes the constraint — a pipeline's latency is the *sum* of all stages, with no parallelism. If two stages don't actually depend on each other, running them in parallel (fan-out, `./04-parallel-fan-out.md`) is cheaper.

### What to explore next
- `./04-parallel-fan-out.md` → what the pipeline becomes when sub-jobs are independent
- `./08-shared-state-and-message-passing.md` → the typed `Diagnosis` is the message-passing version of inter-stage communication
- `./07-graph-orchestration.md` → pipelines expressed as state graphs with checkpointing and conditional edges
- `../../study-system-design-dsa/01-system-design/07-client-stream-handoff.md` → the cross-request handoff via `sessionStorage` from a system-design perspective

---

## Tradeoffs

The decision was: **sequential pipeline with code-owned order and typed inter-stage messages.** The alternative most teams reach for is one mega-agent with all tools and a long prompt covering all responsibilities.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Sequential pipeline (chosen)│ Mega-agent (alternative)    │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build time       │ 3 prompts, 3 tool subsets,  │ 1 prompt covering           │
│                  │ 1 shared loop primitive     │ everything                  │
│ Latency          │ sum of stages (sequential)  │ shorter wall-clock per run, │
│                  │                             │ but more iterations needed  │
│                  │                             │ to cover the work           │
│ Token cost / run │ pays for 3 focused loops    │ one loop with longer prompt │
│                  │                             │ and more turns              │
│ Prompt focus     │ each stage's prompt covers  │ one prompt covers all       │
│                  │ exactly its job             │ responsibilities; drifts    │
│ Tool budget      │ per-stage cap (6/6/4) —     │ shared budget — early stages│
│ contention       │ no contention               │ starve late ones            │
│ Output schema    │ typed Diagnosis between     │ free-form; output drifts    │
│                  │ stages                      │ between detect/diag/rec     │
│ Debugging        │ stage-localized — bug is in │ entire mega-trajectory to   │
│                  │ one prompt or one budget    │ replay                      │
│ Stage swappability│ swap one agent's prompt or │ rewrite the whole prompt    │
│                  │ tools without touching      │                             │
│                  │ others                      │                             │
│ Runtime flex     │ order is fixed              │ model can adapt within one  │
│                  │                             │ run (cost: drifting outputs)│
│ Failure blast    │ a bad stage fails alone     │ a bad turn cascades through │
│                  │                             │ the rest of the loop        │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up runtime adaptability in stage order — `route.ts` L224–L249 hardcodes monitoring → diagnostic → recommendation. The route can't decide to skip the recommendation step if the diagnosis is obvious, or re-run diagnosis with a deeper budget if it was inconclusive. (The user can — the split-step UX lets them not click "see recommendations" — but the *system* can't decide that on its own.)

We also gave up wall-clock latency. The pipeline is sequential; total time = monitoring + diagnostic + recommendation. The diagnostic stage typically takes 5–15 seconds (multiple EQL queries under the ~1 req/s MCP limit); the recommendation stage adds another 3–8 seconds. A fan-out shape would parallelize some of this, at the cost of losing the data dependency (the recommendation truly needs the diagnosis).

### What the alternative would have cost

If we had used one mega-agent with all 20+ tools and a long prompt, the up-front cost would have been a 4–6x larger system prompt covering three responsibilities. The model would have spent budget on "which job am I doing this turn?" decisions instead of doing the work. Output schemas would drift run-to-run — sometimes the mega-agent would return a diagnosis, sometimes recommendations, sometimes both interleaved, sometimes neither. Per-stage caps (6/6/4) wouldn't be expressible because there are no stages.

Concretely: the recommendation step's average ~7s execution would become "somewhere between 0s and 30s depending on whether the mega-agent decided to propose actions this run." That variance breaks the user-gated UX — the user clicks "see recommendations" and gets nothing because the mega-agent already used its budget on detection.

### The breakpoint

This stays the right call until a *stage's output* has to change which *stages* run next — e.g. "if the diagnosis confidence is low, re-run diagnosis with a deeper budget instead of going to recommendation." That branching isn't expressible as a linear pipeline; it's a state graph. At that point you'd move to `./07-graph-orchestration.md`'s shape, keeping the typed inter-stage messages but expressing transitions as graph edges.

### What wasn't actually a tradeoff

Parallel fan-out was not a real alternative for the diagnostic → recommendation transition. The recommendation agent's `propose(anomaly, diagnosis, hooks)` signature literally requires the diagnosis — there's no way to start the recommendation stage before the diagnostic stage completes. The data dependency is real, not a preference.

Skipping the typed `Diagnosis` schema and using free-form prose between stages was also not a real alternative: the cross-request handoff needs to round-trip through a URL query param (`?diagnosis=...`), and `parseDiagnosis()` validates the shape. Without the type, you'd have either no validation or a much messier handoff.

---

## Tech reference

### TypeScript interfaces as inter-agent contracts

- **Codebase uses:** `interface Diagnosis` in `lib/mcp/types.ts` L95–L104 — the inter-stage message between diagnostic and recommendation; `parseDiagnosis()` in `app/api/agent/route.ts` L86–L97 validates the shape at request boundaries.
- **Why it's here:** the type *is* the pipeline contract — both stages reference the same `Diagnosis` type, so a schema change forces both stages to update.
- **Leading today:** TypeScript interfaces (or Zod schemas) as inter-agent contracts — adoption-leading for typed multi-agent designs in TS, 2026.
- **Why it leads:** structural typing makes the contract enforceable at compile time without runtime overhead; Zod adds runtime validation when the contract crosses an untrusted boundary (URL param, sessionStorage).
- **Runner-up:** JSON Schema + Zod — runtime-validated schemas that double as docs; preferred when the contract crosses an HTTP boundary.

### sessionStorage as a step-to-step message bus

- **Codebase uses:** `sessionStorage.setItem('bi:diag:<id>', JSON.stringify({ diagnosis }))` in `lib/hooks/useInvestigation.ts` L138 — persists the diagnosis between step-2 and step-3 HTTP requests.
- **Why it's here:** it's the carrier that lets the pipeline split across user-gated requests without losing the typed message.
- **Leading today:** `sessionStorage` for per-tab persisted state — adoption-leading for browser-scoped step state, 2026.
- **Why it leads:** synchronous read/write, per-tab scope (multi-tab safety), cleared on tab close (no leak between sessions); zero infrastructure cost.
- **Runner-up:** server-side session store (Redis, signed cookies) — needed when the message is too large for a URL param or has to survive a tab close.

### Anthropic Messages API tool_use loops (per-stage agents)

- **Codebase uses:** `runAgentLoop` in `lib/agents/base.ts` L48–L176, called by each of the four agents with its own `system`, `toolSchemas`, and `maxToolCalls`.
- **Why it's here:** the per-stage isolation is implemented by *injecting different tool subsets and prompts into the same loop primitive* — one function, four configurations.
- **Leading today:** Anthropic tool use — innovation-leading for typed agent loops, 2026.
- **Why it leads:** `tool_use`/`tool_result` content blocks let each stage's loop emit structured calls; the same loop function serves all four stages without per-stage forking.
- **Runner-up:** OpenAI Responses API — equivalent shape, larger installed base.

---

## Summary

A sequential pipeline is a `.then()` chain where each function is an agent — agents wired together in a fixed order, with each stage's typed output handed to the next stage's typed input. blooming insights' primary pipeline is monitoring → diagnostic → recommendation, with the inter-stage message being a `Diagnosis` object (`lib/mcp/types.ts` L95–L104) and the order owned by code (`app/api/agent/route.ts` L224–L249). The constraint that made this right is the real data dependency between stages — recommendation literally needs the diagnosis as an input. The cost is sequential latency (no parallelism between stages) and a fixed order (no runtime adaptation). The split-step UX uses the same pipeline with `sessionStorage` as the cross-request carrier, gated by the user clicking "see recommendations."

- The pipeline's order is fixed because the data flow is sequential — the recommendation agent's signature literally takes the diagnosis as an argument.
- Each stage has its own prompt, its own tool subset (`lib/mcp/tools.ts`), and its own budget (`maxToolCalls` 6/6/4) — agents are *focused* by separation, not by prompt cleverness.
- The inter-stage message is a typed `Diagnosis` object; the same message survives in-process (function arg) and cross-request (`sessionStorage` + URL param).
- The combined run (capture/demo) and the split-step run (production UX) share one pipeline — only the carrier of the message changes.
- Worth it while the data dependency is sequential and the order is knowable; promote to graph orchestration the day a stage's output has to change which stages run next.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "why a pipeline" they're testing whether you can defend a *sequential* design under pressure — whether you chose it because the work was sequential, or because you didn't reach for parallelism. The strong signal is naming the data dependency that forces sequential (the recommendation agent's signature takes the diagnosis as an arg). The weak signal is calling pipelines "simpler" without naming the constraint that made simpler enough.

### Likely questions

[mid] Q: What's the inter-stage message in blooming insights?

A: The typed `Diagnosis` object defined in `lib/mcp/types.ts` L95–L104 — it has `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers`, `confidence`, and `timeSeries`. The diagnostic agent returns it, the recommendation agent takes it as the second argument to `propose(anomaly, diagnosis, hooks)`. In the split-step UX it's persisted to `sessionStorage` with key `bi:diag:<id>` between step 2 and step 3.

Diagram:
```
  diagnostic agent              recommendation agent
   investigate()    ──Diagnosis──►   propose(_, diagnosis, _)
                       (typed)

  cross-request:
   sessionStorage.setItem('bi:diag:<id>', JSON.stringify({diagnosis}))
   then ?diagnosis=… in the next request URL
   → parseDiagnosis() validates the shape before resuming
```

[senior] Q: Why didn't you fan these out in parallel?

A: Because the data dependency is real — `RecommendationAgent.propose(anomaly, diagnosis, hooks)` literally takes the diagnosis as its second arg. There's no way to start the recommendation stage before the diagnostic stage completes; the recommendation agent's prompt references `diagnosis.conclusion` and iterates over `diagnosis.evidence[]`. Parallelizing them would mean running recommendation with no input — wasted work I'd throw away. The constraint forcing sequential is the data flow, not preference.

Diagram:
```
  What the signatures say:

  diagAgent.investigate(anomaly): Promise<Diagnosis>
                                       │
                                       ▼
  recAgent.propose(anomaly, diagnosis, hooks): Promise<Recommendation[]>
                            ▲
                            └── this argument forces the order
```

[arch] Q: At 10x anomaly volume, what's the first thing that breaks in the pipeline?

A: Wall-clock latency, not throughput. Per investigation, the pipeline is ~5–15s (diagnostic) + ~3–8s (recommendation), all sequential under the shared ~1 req/s MCP rate limit (`connect.ts` L92). At 10x volume, more concurrent investigations means more concurrent agent loops competing for the same MCP throughput, not faster individual investigations. The fix is fan-out backpressure (concurrency limiter on the agent layer, see `../05-production-serving/02-fan-out-backpressure.md`) and cross-run caching of repeated EQL sub-steps inside each stage. The pipeline shape itself doesn't change — the bottleneck is at the serving layer.

Diagram:
```
  ┌ Route layer (if-ladder) ──── fine, stateless ─────┐
  ┌ Agent layer (4 ReAct loops) ◄─ contention: 10x    │
  │                                investigations share │
  │                                ~1 req/s MCP budget  │
  ┌ MCP layer (~1 req/s) ◄────────── shared bottleneck │
  │                                                     │
  add: fan-out backpressure + cross-run cache here     │
```

### The question candidates always dodge

Q: If the pipeline is sequential, isn't this just "three chained API calls" — why call it multi-agent at all?

A: Because the unit of work between the chained calls is *not* a single LLM call — it's a full ReAct loop with its own tool budget, its own iteration cap, and its own forced-final-turn behavior. The diagnostic agent runs 3–7 turns of `tool_use` + observation before producing the `Diagnosis`; the recommendation agent runs 2–4 turns before producing recommendations. Each link in the chain is itself an autonomous loop. The reason "three chained API calls" understates it is that those three "calls" are non-deterministic in length, variable in tool selection, and each one writes its own internal trajectory. The chain is one shape; the inside of each link is another shape. The accurate framing is "a chain *of agents*" — and naming the outer shape "pipeline" doesn't downgrade the inner shape from "agent" to "call." Anthropic's "Building Effective Agents" deliberately separates "workflow" (the outer shape) from "agent" (the inner shape) because they're orthogonal — you can have a workflow of agents, and that's exactly what this is.

Diagram:
```
  Outer shape: pipeline (sequential, code-owned order)

  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │  Stage A │ ─Diag─► │  Stage B │ ─Recs─► │ Client   │
  └──────────┘         └──────────┘         └──────────┘
       │                     │
       │ zoom into one stage │
       ▼                     ▼
  Inner shape: ReAct LOOP (variable length, model-driven)

   reason → tool → observe → reason → tool → observe → … → final

   chain of agents ≠ chain of calls
```

### One-line anchors

- "The pipeline order is fixed because the data flow is sequential — `propose(_, diagnosis, _)` requires the diagnosis as an argument."
- "Each stage has its own prompt, its own tool subset, and its own budget — focus by separation, not by prompt cleverness."
- "The typed `Diagnosis` is the message; it survives in-process as a function arg and cross-request as a `sessionStorage` value."
- "It's a chain of agents — the outer shape is sequential, the inner shape is a ReAct loop. Naming the outer 'pipeline' doesn't downgrade the inner from 'agent' to 'call.'"

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the sequential pipeline from memory: three boxes (monitoring → diagnostic → recommendation), arrows between them labelled with the message type (Anomaly → Diagnosis → Recommendations). Then add a second layer below the diagnostic box showing the ReAct loop inside one stage.

Open the file. Compare.

✓ Pass: you drew three stages, labelled the inter-stage messages (especially Diagnosis), and showed the ReAct loop inside one stage
✗ Fail: re-read How it works Layer 1 and the diagram section, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain the pipeline to a colleague who asked "why isn't this all one agent?" — under 90 seconds, no notes.

Checkpoints — did you:
- Name `app/api/agent/route.ts` L224–L249 (the code that owns the order)?
- Name the inter-stage message (`Diagnosis` in `lib/mcp/types.ts`)?
- Say why the order is sequential (data dependency: recommendation needs diagnosis)?
- Name the per-stage budgets (6/6/4) and why they matter (tool budget contention)?

If you skipped any: you described the pipeline, you didn't defend it.

### Level 3 — Apply it to a new scenario

A product manager proposes: "Add a fourth stage — `summary` — that runs after recommendation and produces a one-paragraph summary the user can copy-paste into Slack." The summary needs the diagnosis AND the recommendations as input.

Without looking at the file: where would `summary` slot into the pipeline? What new type would you add to `lib/mcp/types.ts`? Which line range of `route.ts` would change, and how does the in-process / cross-request handoff change?

Write your answer (3–5 sentences). Then open `app/api/agent/route.ts` L244–L249 and check whether the change is a straightforward extension or whether the cross-request handoff (now with two messages — diagnosis AND recommendations) is the load-bearing complication.

### Level 4 — Defend the decision you'd change

"If you were building this today with the same problem (anomaly → diagnose → recommend) but with a hard 5-second total latency budget, would you still use a sequential pipeline? Why or why not? If you'd switch to a different topology, which one (parallel fan-out? mega-agent?), and how would you handle the recommendation agent's data dependency on the diagnosis?"

Reference the code: `route.ts` L237–L248 (the in-process pipeline), `recommendation.ts:propose(anomaly, diagnosis, hooks)` signature, `connect.ts` L92 (the ~1.1s MCP spacing that bounds per-stage latency).

### Quick check — code reference test

Without opening any files:
- What file defines the inter-stage message type?
- What's the key the client uses to persist the diagnosis between step 2 and step 3?
- What function validates the handed-over diagnosis when step 3 starts?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Applied study.md v1.46 Move-2-variant (load-bearing skeleton: isolate the kernel + what-breaks-if-removed + skeleton vs hardening) to How it works.
