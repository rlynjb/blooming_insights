# Sequential pipeline (agents as pipeline stages)

**Industry name(s):** Sequential pipeline, prompt chain, agent-as-pipeline-stage, agentic chain
**Type:** Industry standard · Language-agnostic

> The primary topology in blooming insights: monitoring → diagnostic → recommendation, with the typed `Diagnosis` handed step-to-step as a structured message. The user gates the transition between stages. Each stage is a ReAct loop with its own tool subset and budget — but the order between them is fixed and owned by code.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Sequential pipeline IS the Pipeline coordinator band in blooming insights. `lib/agents/pipeline.ts` is the file — the place where `monitoring → diagnostic → recommendation` is wired as a `.then()` chain of agents, with the typed `Diagnosis` flowing from stage two into stage three as the input that the next agent literally cannot start without. The Per-agent definitions below are the stages; the Shared agent loop below them is what each stage runs inside. This is the topology blooming insights actually uses — every other topology in this folder is a contrast against this one.

```
  Zoom out — where sequential pipeline lives

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Pipeline coordinator ──▼────────────────────────┐  ← we are here
  │  ★ lib/agents/pipeline.ts ★                       │
  │  monitoring ──► diagnostic ──► recommendation     │
  │              Anomaly        Diagnosis             │
  │  output of one stage IS input of the next         │
  │  (typed handoff, fixed order, no parallelism)     │
  └─────────────────────────┬────────────────────────┘
                            │  per-stage invocation
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring.ts | diagnostic.ts | recommendation.ts│
  └─────────────────────────┬────────────────────────┘
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop (lib/agents/loop.ts) per stage     │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you wire agents as pipeline stages instead of one mega-agent or parallel workers? Sequential pipeline is the answer when the sub-jobs are real (different prompts, different tools, different schemas) AND the order is fixed by a data dependency (each stage needs the previous one's output to start). blooming insights ticks both boxes: the typed `Diagnosis` is literally an input to `recommendation.propose(anomaly, diagnosis, hooks)`. Below, you'll see the mechanics — the typed handoffs, the per-stage budgets, and the schema gate between stages.

---

## Structure pass

**Layers.** Sequential pipeline is anchored to real code in this codebase, so the layers are concrete: the **Pipeline coordinator** (`lib/agents/pipeline.ts` plus the route's `if`-ladder — wires `monitoring → diagnostic → recommendation` and carries the typed `Diagnosis` from stage two into stage three's call signature), the **Per-agent stages** (`monitoring.ts` / `diagnostic.ts` / `recommendation.ts` — each defining its system prompt, tool subset, iteration budget, and synthesis instruction), the **Shared agent loop** (`runAgentLoop` — what each stage runs internally), and the **Typed handoff schemas** (`Anomaly`, `Diagnosis` — the value types passed between stages, the contract that makes the chain typed). The user gates the cross-stage transition; everything else is mechanical.

**Axis: control.** Who decides the order of stages, and who decides what happens inside a stage? This is the right axis because the entire shape of a sequential pipeline is *placing the control flow* at two levels — CODE owns the cross-stage order, MODEL owns the within-stage work. Dependency is a tempting alternate (the data flow IS sequential — stage 3 needs stage 2's `Diagnosis`), but dependency is what the order *encodes*; control is the placement question the topology answers.

**Seams.** Two seams matter, and the second is THE seam this topology is built on. Seam 1 sits between stages — between one Per-agent's output and the next Per-agent's input. Control stays in CODE on both sides (the coordinator picks the next call, the `Diagnosis` is just an argument). The seam is real (it's where the typed handoff lives, where the user-gate sits, where you'd add a re-run or skip later) but control doesn't flip across it. Seam 2 sits between the Pipeline coordinator and the Shared agent loop, *inside* every stage — control flips from CODE (coordinator picks the stage and hands it inputs) to MODEL (the agent loop decides which tool to call). This is the load-bearing seam: it's the chains-vs-agents boundary repeated at every stage, and it's why this topology is "a chain of agents" rather than "a chain of LLM calls."

```
  Structure pass — Sequential pipeline

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Pipeline coordinator (lib/agents/pipeline.ts) │
  │  Per-agent stages (monitoring/diag/rec)        │
  │  Shared agent loop (runAgentLoop)              │
  │  Typed handoff schemas (Anomaly, Diagnosis)    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who owns order across stages, and    │
  │           who owns work within a stage?        │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: stage N output ↔ stage N+1 input      │
  │          (CODE → CODE, typed handoff)          │
  │  Seam 2: Pipeline coord ↔ Shared agent loop    │
  │          (CODE → MODEL, repeated each stage)   │
  │          ★ load-bearing — this is why each     │
  │          stage IS an agent, not just a call    │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  Seam 2 — "who decides the next move?" answered two ways, at every stage

  ┌─ Pipeline coord ─┐    seam      ┌─ Agent loop ──┐
  │  CODE: order is  │ ═════╪═════► │ MODEL: tool   │
  │  monitoring →    │   (flips,    │ calls chosen  │
  │  diag → rec      │   every      │ turn by turn  │
  │  (fixed)         │   stage)     │ (variable)    │
  └──────────────────┘              └───────────────┘
         ▲                                     ▲
         └───── same axis (control), two answers ─┘
                → this seam fires N times per request
```

The skeleton is mapped — the rest of this file walks the typed handoffs, the per-stage budgets, and the schema gate between stages.

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
              (the route handler's if-ladder)
              + (cross-request handoff via session storage)
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

1. **Typed inter-stage message** — a concrete schema (here: a Diagnosis with `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers` / `confidence` / `timeSeries`). Stage N+1 takes it as a typed argument; the type system enforces that "stage N's output is a valid stage N+1 input."
2. **A handoff carrier** — *something* that moves the typed value from stage N to stage N+1. Two carriers ship in this repo: a function argument when stages run in the same request, a session-storage-write-plus-URL-param-read when they don't. Same message, two carriers.
3. **A gate that picks who runs next** — the route handler reads a step query param (diagnose | recommend) and picks the lead agent. Code, not an LLM. The Combined Run path makes this gate automatic ("after diagnose, recommend"); the Split Steps path makes it user-driven (the user clicks "see recommendations").
4. **Per-stage tool subset + budget** — each stage gets only the tools it needs and a budget calibrated to its job (monitoring 6, diagnostic 6, recommendation 4, query 6). The budget IS the per-stage isolation.

The wire-level mechanics — what the diagnosis object looks like, how its session-storage handoff key is shaped, what the inbound parse function validates, how the route's if-ladder dispatches — are below. The kernel is what makes this a pipeline; everything else is hardening.

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
  (the inter-stage contract)                │   in-process (PRESENT — Combined
diagnostic stage: investigate() →           │   Run mode for capture + demo)
  Promise<Diagnosis>                        ├ Carrier #2: session storage +
recommendation stage: propose(anomaly,      │   URL param across requests
  diagnosis, …) consuming the typed Dx      │   (PRESENT — Split Steps mode,
route picks the next agent from ?step       │   the production UX)
per-stage tool-call budget + tool subsets   ├ save-investigation +
                                            │   filter-by-step replay so the
                                            │   captured event log replays
                                            │   in either mode (PRESENT —
                                            │   the demo path)
                                            ├ streaming each stage's
                                            │   intermediate output (the
                                            │   "diagnosis" event) so the
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
                                            │   see the supervisor-worker
                                            │   note)
                                            └ parallel fan-out across peer
                                                stages (ABSENT — stages are
                                                inherently sequential here;
                                                see the parallel-fan-out
                                                note)
```

The takeaway is **the pipeline is one shape with two carriers.** In-process: a function call (`dx = await diag.investigate(...); await rec.propose(inv, dx, ...)`). Across requests: a session-storage write plus a URL-param read. The *typed message* — Diagnosis — is the invariant. The carrier is hardening that varies by mode.

This is what people mean by "agents as pipeline stages": agents that ship typed messages between themselves the way functions ship typed return values, with code owning the order.


The full picture is below.

---

## Sequential pipeline — diagram

```
Sequential pipeline — the full picture in this codebase

  ┌─ CODE LAYER (order owner) ────────────────────────────────────────────┐
  │  the route handler's if-ladder                                        │
  │                                                                       │
  │  if step == 'recommend':                                              │
  │     diagnosis = parse_diagnosis(URL ?diagnosis=…)  ◄── handoff in     │
  │  else:                                                                │
  │     diagnosis = await diag_agent.investigate(inv, hooks)              │
  │     send('diagnosis', diagnosis)                   ──► handoff out    │
  │                                                                       │
  │  if step != 'diagnose':                                               │
  │     recs = await rec_agent.propose(inv, diagnosis, hooks)             │
  │     send('recommendation', …)                                         │
  └───────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ AGENT LAYER (each stage is a ReAct loop) ───────────────────────────┐
  │                                                                       │
  │  ┌─ Diagnostic stage ──┐         ┌─ Recommendation stage ──┐         │
  │  │ prompt: investigate │         │ prompt: propose actions  │         │
  │  │ tools: 6 analytics  │         │ tools: 4 feature-spec    │         │
  │  │ budget: 6 calls     │         │ budget: 4 calls          │         │
  │  │ output: Diagnosis   ├────────►│ input:  Diagnosis        │         │
  │  └─────────────────────┘         └──────────────────────────┘         │
  │       │                                  │                            │
  │       └──────► shared agent loop ◄───────┘                            │
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
  │  (the typed contract between diagnostic and recommendation stages)    │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

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

  // route.ts — code owns the pipeline order; agents take the DataSource seam
  if (step === 'recommend') {
    diagnosis = parseDiagnosis(diagnosisParam);  // resumed handoff
  } else {
    const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools);
    diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
    send({ type: 'diagnosis', diagnosis });      // emit to UI + persist
  }

  if (step !== 'diagnose') {
    const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools);
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
- `../../study-system-design/07-client-stream-handoff.md` → the cross-request handoff via `sessionStorage` from a system-design perspective

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

## See also

→ `./01-when-not-to-go-multi-agent.md` · → `./02-supervisor-worker.md` · → `./08-shared-state-and-message-passing.md` · → systems view: `../../study-system-design/06-multi-agent-orchestration.md` · → client handoff: `../../study-system-design/07-client-stream-handoff.md` · → chain/agent boundary: `../01-reasoning-patterns/01-chains-vs-agents.md`

---
