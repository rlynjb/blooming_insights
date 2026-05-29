# Supervisor-worker

**Industry name(s):** Supervisor-worker, manager-worker, orchestrator-workers, hub-and-spoke
**Type:** Industry standard · Language-agnostic

> The most common multi-agent topology — a central supervisor decomposes a task, delegates to specialist workers, synthesizes their results. blooming insights does NOT have an LLM supervisor; the route file is a *hard-coded* supervisor (code decomposes the user journey, picks the agent), which is the same shape with the supervisor role played by an `if`-ladder instead of a model.

**See also:** → `./01-when-not-to-go-multi-agent.md` · → `./03-sequential-pipeline.md` · → `./06-swarm-handoff.md` · → `../06-orchestration-system-design-templates/` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → routing primitive: `../01-reasoning-patterns/01-chains-vs-agents.md`

---

## Why care

### Move 1 — the scenario (lead with the shape)

```
The supervisor-worker shape

         ┌─────────────────────────────────┐
         │       Supervisor                │
         │  (decomposes task, delegates,    │
         │   collects results, synthesizes) │
         └──────┬──────────┬──────────┬─────┘
                ▼          ▼          ▼
           ┌────────┐ ┌────────┐ ┌────────┐
           │worker A│ │worker B│ │worker C│
           │(spec.) │ │(spec.) │ │(spec.) │
           └────┬───┘ └────┬───┘ └────┬───┘
                └──────────┼──────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

You have a manager `<Page>` component. It receives a user request, owns the overall state, and delegates rendering to three child components — one for the header, one for the list, one for the footer. Each child does its job and returns its rendered output; the page assembles the final UI from those three returns.

Now picture that, but the children are *agents*, and the parent is also a *kind of agent* — except the parent's job isn't to render UI, it's to decide which children to invoke, in what order, and how to merge their answers.

### Move 2 — name the question

That parent — the role that decomposes a user request into sub-jobs, picks which worker runs each one, and merges the workers' outputs back into a single answer — is what supervisor-worker names. The question this file answers: **when does that supervisor role need to be a model, and when can code play the same role?**

That last clause matters. The shape is the same either way. A supervisor is whoever decomposes-delegates-merges; it does not have to be an LLM. blooming insights' route file plays exactly that role, just deterministically.

### Move 3 — why answering that question matters

**What depends on getting this right:** the entire cost ledger of your multi-agent system. An LLM supervisor pays a model call per ordering decision, runs its own ReAct loop with its own iteration cap, and adds a third suspect to every bug ("did the supervisor mis-route?"). A code supervisor pays zero extra LLM cost and adds zero extra suspects — but it can only express decompositions you can predict.

The thing to refuse: the implicit claim that "supervisor-worker" requires an LLM supervisor. It doesn't. The pattern is about *the role*, not the implementation. Most production multi-agent systems use code supervisors and tell themselves they're "not really multi-agent" — they are. They've just been honest about not needing a model for the supervisor's job.

In this codebase: there is a supervisor. It lives in `app/api/agent/route.ts` L199–L249. It decomposes the user journey (free-form query vs anomaly investigation vs split-step recommend), picks the worker agent, and hands one worker's output (the typed `Diagnosis`) to the next worker. It is a supervisor that does not reason — and that's the deliberate choice.

### Move 4 — the two flavors, walked

LLM supervisor flavor (not this codebase):
- User: "compare last week's revenue to the prior week"
- Supervisor agent reads the request, picks worker A (analytics), delegates
- Worker A returns data
- Supervisor decides whether to call worker B (segments) based on what A returned
- Supervisor synthesizes a final paragraph from both workers' results
- Cost: 3 agent loops (supervisor + 2 workers) + supervisor synthesis cost

Code supervisor flavor (this codebase):
- User opens an anomaly card → route reads `insightId` query param
- `if`-ladder in `route.ts` picks `DiagnosticAgent` (decomposition is hard-coded — the user journey is the decomposition)
- Diagnostic worker investigates, returns a typed `Diagnosis`
- Route hands the diagnosis to `RecommendationAgent.propose(...)` — the merge is a function call, not a model
- Cost: 2 worker loops, zero supervisor LLM cost

### Move 5 — one-line summary

A supervisor-worker is one role (decompose-delegate-merge) over a set of specialists; blooming insights has the role played by code (`route.ts`'s `if`-ladder), not by a model. Here's how both flavors work.

---

## How it works

**The mental model: a parent component that delegates to children and assembles their returns.** What changes between flavors is who's doing the delegation reasoning — code or a model — and that single choice changes the cost ledger, the debug surface, and the failure modes.

```
The supervisor's job in one diagram

   incoming request
         │
         ▼
   ┌───────────────────────────────┐
   │  SUPERVISOR ROLE              │
   │   1. decompose the request    │
   │      into sub-jobs            │
   │   2. pick the worker for      │
   │      each sub-job             │
   │   3. delegate (with context)  │
   │   4. collect results          │
   │   5. synthesize an answer     │
   └─────┬─────────────────────────┘
         │  who plays this role?
         │
   ┌─────┴──────────────────────┐
   │                            │
   ▼                            ▼
LLM supervisor              CODE supervisor
(model reasons              (engineer-written
 about each step)            if-ladder + function
                             calls)
```

The strategy in plain English: **pick the implementation of the supervisor role by whether the steps it makes need runtime data the engineer can't know.** If yes, an LLM. If no, code.

### Layer 1 — the supervisor's three jobs, no matter who plays it

The technical thing: a supervisor always does three things — *decompose*, *delegate*, *synthesize*. Every supervisor-worker topology in the world is some shape of these three.

If you're coming from frontend, this is a parent component's three jobs in any composition: own state, render the right child for the current state, merge child callbacks into the parent's state. Whether the parent is a `<Page>` with `if/else` JSX or a state-machine-driven `<Wizard>`, the three jobs are the same. Same here.

```
Supervisor's three jobs

  ┌───────────────────────────────────────┐
  │ 1. DECOMPOSE                          │
  │    "this request = job A + job B + …" │
  └───────────────────────────────────────┘
              │
              ▼
  ┌───────────────────────────────────────┐
  │ 2. DELEGATE                           │
  │    pick worker for each job;          │
  │    hand off the right context         │
  └───────────────────────────────────────┘
              │
              ▼
  ┌───────────────────────────────────────┐
  │ 3. SYNTHESIZE                         │
  │    merge worker outputs into          │
  │    the user-facing answer             │
  └───────────────────────────────────────┘
```

The practical consequence: when a multi-agent system goes wrong, the failure is in one of those three steps. Decomposition failure (supervisor decomposed the request into the wrong sub-jobs). Delegation failure (picked the wrong worker, or sent the wrong context). Synthesis failure (merged contradictory worker outputs into a confident-sounding wrong answer). The diagnostic question every bug starts with: which of the three?

The condition under which this works: the supervisor's three jobs need to actually be the right framing for the problem. They are when the workers are *single-purpose specialists* and the problem genuinely decomposes. They aren't when the workers are *peers* that hand control to each other directly (that's swarm — see `./06-swarm-handoff.md`).

### Layer 2 — tools-style supervisor (control stays with the supervisor)

The technical thing: the supervisor stays in its own loop and calls workers *as tools*. The supervisor's `runAgentLoop` includes "call worker A" as one of its `tool_use` options. When the supervisor decides it needs worker A, it emits a tool call; your runtime invokes worker A; worker A's answer comes back as a `tool_result`; the supervisor reasons about what to do next.

If you're coming from frontend, this is a parent component that renders children but holds onto refs and calls child methods imperatively — the parent is *still in charge* between every child interaction. The control flow is never transferred to the child.

```
Tools-style: supervisor uses workers as tools

  Supervisor loop:
    turn 1: model emits tool_use("call_worker_A", args)
              │
              ▼
            [your code runs worker A]
              │
              ▼
            tool_result(worker A's answer)
              │
              ▼
    turn 2: model reasons over A's result
              model emits tool_use("call_worker_B", args)
              │
              ▼
            [your code runs worker B]
              │
              ▼
            tool_result(worker B's answer)
              │
              ▼
    turn 3: model synthesizes → final answer
```

The practical consequence: the trajectory is one trajectory — the supervisor's. Worker calls are *steps* inside the supervisor's loop. Debugging is "replay the supervisor's trajectory and look at each tool_result." Easy to trace. The cost is that the supervisor's context window has to carry every worker's output for the rest of the run, which is exactly the "lost-in-the-middle" failure mode at scale.

The condition under which this works: the workers' outputs are small enough that carrying them through the supervisor's window doesn't blow it up, AND the supervisor genuinely needs to reason about each worker's result before picking the next.

### Layer 3 — handoff-style supervisor (control transfers to the worker)

The technical thing: the supervisor invokes a worker, and *control transfers* — the supervisor's loop stops, the worker's loop runs until it produces a final answer or hands back. The supervisor is "off" while the worker is "on." When the worker is done, the supervisor's loop resumes (or another agent picks up).

If you're coming from frontend, this is routing in a SPA — the parent renders `<Route path="/a">` and *control transfers* to the route's component; the parent doesn't run while the route is rendering. You navigate back and the parent resumes.

```
Handoff-style: control transfers to the worker

  Supervisor (turn 1): "this is a billing question → BillingAgent"
                       │ HANDOFF
                       ▼
  BillingAgent loop runs its own ReAct turns
   (independent loop, own tool budget, own prompt)
                       │
                       ▼
  BillingAgent (turn N): "I need help with shipping → ShippingAgent"
                       │ HANDOFF
                       ▼
  ShippingAgent loop runs … etc.
```

The practical consequence: the trajectory is *fragmented* across multiple agent runs. Debugging is "find the right loop's trajectory, then the next one, then the next." Each agent's context window is fresh and small (a win), but the *narrative* of what happened is now distributed across loops. Failure modes from `./06-swarm-handoff.md` (infinite handoff) start to apply.

The condition under which this works: each worker is large enough (or specialized enough) that running it as a sub-tool inside the supervisor's window would explode context, AND the order of workers genuinely depends on what one worker emits.

### Phase A vs Phase B — the route as a supervisor that does not reason

Right now in blooming insights, the supervisor role exists — it's played by code. Here's what would change if a future quality requirement forced it to become an agent.

```
        Now (route as code supervisor)        If quality forced it (LLM supervisor)
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ app/api/agent/route.ts L199–L249    │  │ a new SupervisorAgent class         │ ←
│   if q && !insightId  → QueryAgent  │  │   runAgentLoop with worker-as-tool  │
│   else step === 'recommend'         │  │   schemas for diagnostic /          │
│     → RecommendationAgent           │  │   recommendation / query            │
│   else                              │  │                                     │
│     → DiagnosticAgent               │  │ supervisor decides ORDER at runtime │
│       then RecommendationAgent      │  │ (skip, loop, re-order)              │
│   ▼                                 │  │   ▼                                 │
│ workers are unchanged               │  │ workers are unchanged                │ ←
│ (DiagnosticAgent.investigate, etc.) │  │ (same agent classes, same loops)    │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   the WORKERS don't change in either phase — only the
   supervisor's implementation moves from code to model
```

*Now:* the supervisor is `route.ts`'s `GET` handler. It decomposes the request via query-string fields (`insightId`, `q`, `step`), picks the worker by `if`-ladder, hands the typed `Diagnosis` from one worker to the next via a function call, and "synthesizes" by streaming workers' outputs to the client in order. The decomposition is hard-coded because the user *journey* is the decomposition: there are exactly three product flows.

*If quality forced it:* the day the user journey isn't expressible as 3 product flows — e.g. when "anomaly type" branches into 20 specialist worker agents and the route file becomes a switchboard — a supervisor agent earns its overhead. The workers (`DiagnosticAgent`, `RecommendationAgent`, etc.) don't change at all; only the *outer* implementation of decompose-delegate-merge moves from code to a model.

The takeaway: **a "hard-coded supervisor" is still a supervisor.** It plays the supervisor role; it just doesn't reason. Naming this out loud is what keeps the architecture honest — the codebase is supervisor-worker shaped, with the supervisor implemented as `if`s.

This is what people mean by "use the simplest supervisor that fits." The hard-coded one is the simplest. Promote only when the decomposition needs to be runtime-decided.

The full picture is below.

---

## Supervisor-worker — diagram

```
Supervisor-worker — the two flavors

  ┌─ FLAVOR 1: TOOLS-STYLE (control stays at the top) ──────────┐
  │                                                              │
  │   ┌─────────────────────────────┐                            │
  │   │ Supervisor agent (one loop) │                            │
  │   │                             │                            │
  │   │  turn N: tool_use("call_A") ├──► [worker A]              │
  │   │            ◄────────────────┤    returns result          │
  │   │  turn N+1: tool_use("call_B")├──► [worker B]              │
  │   │            ◄────────────────┤    returns result          │
  │   │  turn N+2: synthesize       │                            │
  │   └─────────────────────────────┘                            │
  │   trajectory: ONE (the supervisor's)                         │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ FLAVOR 2: HANDOFF-STYLE (control transfers) ────────────────┐
  │                                                              │
  │   ┌──────────┐  handoff  ┌──────────┐  handoff  ┌──────────┐│
  │   │supervisor│ ──────────►│worker A  │ ──────────►│worker B  ││
  │   └──────────┘            └──────────┘            └──────────┘│
  │   trajectory: FRAGMENTED across loops                        │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ FLAVOR 3 (this codebase): CODE SUPERVISOR ──────────────────┐
  │                                                              │
  │   app/api/agent/route.ts (no LLM in the supervisor role)     │
  │   ┌────────────────────────────────────────────────────┐     │
  │   │ if q && !insightId   → QueryAgent                  │     │
  │   │ else step==='recommend' → RecommendationAgent      │     │
  │   │ else                  → DiagnosticAgent +          │     │
  │   │                          RecommendationAgent       │     │
  │   └─────────────────┬──────────────────────────────────┘     │
  │                     ▼                                        │
  │   workers (DiagnosticAgent, RecommendationAgent, …)          │
  │   are ReAct loops — but the supervisor is code               │
  │                                                              │
  │   trajectory: ONE per worker; the route streams them         │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Not yet implemented as an LLM supervisor — and deliberately so.**

The supervisor *role* is filled by `app/api/agent/route.ts` (lines L199–L249), which decomposes the user journey, picks the worker agent, hands one worker's output to the next, and streams the merge. It plays every part of the supervisor role except *reasoning about which step to take* — that's hard-coded.

The honest sentence: blooming insights doesn't need an autonomous supervisor because the user journey has exactly three product flows (free-form query, anomaly investigation, split-step recommend), and those flows are knowable up front — so the route file's `if`-ladder expresses the decomposition without any model help.

**The "hard-coded supervisor" entry point**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body
**Line range:** L199–L249 — lead-agent select (L199–L200), query branch (L210–L218), diagnostic→recommendation handoff (L224–L249)

**The workers (one shared loop, four agent classes)**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L48–L176 — called by every worker (`DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `MonitoringAgent`); per-worker `maxToolCalls` (6/6/6/4) cap the loop budget

**For the LLM-supervisor refactor:** see `../06-orchestration-system-design-templates/` for the concrete "how to make this codebase a multi-agent research assistant" template — the workers in this codebase already fit the worker shape; the supervisor is what would be added.

```
shape (the supervisor role, played by code):

  // app/api/agent/route.ts — the "supervisor" is this if-ladder
  const leadAgent: AgentName =
    q && !insightId      ? 'coordinator'    // → QueryAgent
    : step === 'recommend' ? 'recommendation' // → RecommendationAgent
                           : 'diagnostic';   // → DiagnosticAgent + RecommendationAgent

  // Decompose: the request shape IS the decomposition
  // Delegate: pick the worker by query param
  // Synthesize: function call, not LLM merge
  const diagnosis = await diagAgent.investigate(inv, hooks); // worker A
  const recs     = await recAgent.propose(inv, diagnosis, hooks); // worker B
  // (the route streams these to the client in order)
```

---

## Elaborate

### Where this pattern comes from

Supervisor-worker is the oldest multi-agent shape. It predates LLMs — every job-queue system (Celery, Sidekiq, BullMQ) is supervisor-worker: a producer puts a job on a queue, workers pick it up. The LLM-supervisor version got its current framing from Anthropic's "Building Effective Agents" (2024), which called it the "orchestrator-workers" pattern and named the key decomposition: a central LLM dynamically breaks down tasks, delegates to worker LLMs, and synthesizes their results. LangGraph, OpenAI's Agents SDK, and CrewAI all ship supervisor-worker as their default template.

### The deeper principle

**The supervisor role is a job, not an implementation.** Decompose-delegate-merge is the job. It can be done by a model, by code, by a queue, or by a human. Choosing the implementation is choosing where on the cost ledger you want to land: model = adaptive but expensive; code = predictable but rigid; queue = scalable but eventual; human = high-quality but slow.

```
Same role, different implementations

  Implementation     Cost                      Best when
  ─────────────────  ───────────────────────   ───────────────────
  LLM supervisor     +1 LLM call / decision,   decomposition
                     +token spend (2-5x),       depends on data
                     +1 debug suspect           the engineer can't
                                                know up front

  Code supervisor    free, deterministic,       decomposition is
                     2 debug suspects           knowable (this
                                                codebase)

  Queue              eventual, async,           heavy fan-out with
                     observability is built-in  worker independence

  Human              slow, high-quality,        irreversible / high-
                     0 LLM cost                 stakes decisions
```

### Where this breaks down

Supervisor-worker breaks when the workers genuinely need to talk *to each other*, not back through the supervisor. At that point the supervisor becomes a bottleneck — every cross-worker exchange has to round-trip through the central reasoner. That's the moment swarm/handoff (`./06-swarm-handoff.md`) earns its overhead.

It also breaks when one worker's output is so large that the supervisor's context window can't hold it — at that point you need *summarization workers* between the specialist and the supervisor, which is its own pattern (sub-supervisors / hierarchical).

### What to explore next
- `./03-sequential-pipeline.md` → a degenerate supervisor-worker where the supervisor decomposes into a fixed *chain* of workers (this codebase)
- `./06-swarm-handoff.md` → what supervisor-worker becomes when the central bottleneck is the constraint
- `./07-graph-orchestration.md` → supervisor-worker expressed as an explicit state machine, with checkpointing
- `../06-orchestration-system-design-templates/` → the "design a multi-agent research assistant" template that names exactly what an LLM supervisor on top of this codebase's workers would look like

---

## Tradeoffs

The decision was: **keep the supervisor role, but implement it as code.** The alternative is the LLM-supervisor version of the same role.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Code supervisor (chosen)    │ LLM supervisor (alternative)│
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build time       │ ~50 lines in route.ts       │ supervisor prompt + own     │
│                  │                             │ loop + worker-as-tool       │
│                  │                             │ schemas + handoff protocol  │
│ Latency / run    │ 0 extra LLM calls           │ +1 model call per ordering  │
│                  │                             │ decision (~1–3s under MCP   │
│                  │                             │ rate limit)                 │
│ Token cost / run │ workers only                │ workers + supervisor turns  │
│                  │                             │ (typically 2-5x total)      │
│ Decomposition    │ knowable at code-write time │ runtime, can adapt          │
│ flexibility      │ only                        │                             │
│ Debug surface    │ 2 suspects (route OR worker)│ 3 suspects (supervisor,     │
│                  │                             │ workers, synthesis)         │
│ Context window   │ never bloats                │ supervisor accumulates      │
│                  │                             │ every worker's output       │
│ Failure modes    │ shares all of `./09`'s      │ adds: synthesis failure,    │
│ added            │ except synthesis-failure    │ infinite tool-call cascade  │
│ Synthesis        │ a function call (typed      │ an LLM merge (may fabricate │
│                  │ Diagnosis → propose)        │ or average contradictions)  │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up runtime flexibility in decomposition. The route can't introspect the user's question and decide "this anomaly needs a deep-dive specialist, not the generic diagnostic agent" — that branching has to be a code change. The decomposition is whatever the product team encoded in the query-string contract.

We also gave up *adaptive synthesis*. When the diagnostic agent returns and the recommendation agent runs, the merge is a function call (the diagnosis is handed in as an arg). An LLM supervisor could merge them into a single narrative or surface contradictions; the code supervisor just hands one to the next.

### What the alternative would have cost

If we'd built an LLM supervisor, the up-front cost would have been an entire fourth agent (the supervisor) with its own prompt, its own `runAgentLoop`, its own tool subset (the *workers* would be its tools), and a synthesis instruction. Every investigation would pay an extra ~1–3s under the MCP rate limit for the supervisor's reasoning turn, *plus* additional turns if the supervisor needed multiple decisions. Token cost would land in the 2-5x range typical of supervisor-worker systems. Debugging would now have to walk three trajectories per run: the supervisor's reasoning, the worker's loop, and the synthesis turn.

### The breakpoint

This stays the right call until the user journey can't be expressed as a finite `if`-ladder — e.g. when "anomaly type" branches into 20+ specialist workers, or when the user can type a free-form goal that has to be parsed into an arbitrary sub-task plan. The day the route file becomes a switchboard with more cases than a single screenful of `if`s, an LLM supervisor's reasoning over the same decisions becomes cheaper to maintain than the code.

### What wasn't actually a tradeoff

A "supervisor agent that just hands off to the right worker without doing anything else" was not a real alternative — that's just an LLM doing what an `if` does, with extra steps. If the supervisor's only job is routing-by-input, an `if`-ladder strictly dominates: same decision, no LLM cost. The supervisor agent earns its overhead only when its job goes beyond "pick a worker" into "decompose into multiple sub-jobs, decide their order, possibly retry."

---

## Tech reference

### Anthropic Messages API tool_use (supervisor-as-tools mechanic)

- **Codebase uses:** `runAgentLoop` (`lib/agents/base.ts` L102) calls `anthropic.messages.create({ tools, messages })` — the same primitive that a tools-style supervisor would use to call workers-as-tools (it currently calls MCP tools, but the shape is identical).
- **Why it's here:** it's the primitive that *could* support an LLM supervisor without a framework — define workers as tools, pass them to a supervisor's `runAgentLoop`. The codebase doesn't do this; it just calls the workers directly from `route.ts`.
- **Leading today:** Anthropic tool use — innovation-leading for tools-style supervisor implementations, 2026.
- **Why it leads:** the `tool_use` content block makes worker-as-tool a first-class primitive — no framework wrapper required.
- **Runner-up:** OpenAI Agents SDK `handoffs` API — handoff-style supervisor with structured control transfer baked in.

### LangGraph (the most common LLM-supervisor framework)

- **Codebase uses:** not used. Listed here for the alternative landscape.
- **Why it's here:** LangGraph's `StateGraph` is what teams reach for when they want an LLM supervisor with checkpointing and human-in-the-loop pauses on top.
- **Leading today:** LangGraph — innovation-leading for graph-style supervisor-worker orchestration with state, 2026.
- **Why it leads:** explicit state machine, checkpointing for pause/resume, first-class human-in-the-loop interrupts — the things `route.ts`'s `if`-ladder cannot give you.
- **Runner-up:** OpenAI Agents SDK — simpler model (handoffs as tools), less ceremony, no built-in checkpointing.

### Next.js App Router (the "code supervisor" runtime)

- **Codebase uses:** `app/api/agent/route.ts` is a Next.js App Router route handler; the `GET` function IS the supervisor.
- **Why it's here:** the runtime that lets the code supervisor stream worker outputs as NDJSON in order — the synthesis is "stream worker A's events, then worker B's events."
- **Leading today:** Next.js App Router — adoption-leading for full-stack TS endpoints, 2026.
- **Why it leads:** co-locates the supervisor with the rest of the app, streams natively, runs on Node or edge — the streamed trace is built on this.
- **Runner-up:** Hono / Express + separate stream server — more control over runtime, at the cost of a separate deploy.

---

## Summary

Supervisor-worker is one role (decompose-delegate-merge) over a set of specialist workers; the supervisor can be implemented as an LLM (adaptive, expensive), as code (predictable, free), as a queue, or as a human. blooming insights has the role played by code — `app/api/agent/route.ts` L199–L249 is a "hard-coded supervisor" that decomposes the user journey via query-string fields, picks the worker agent by `if`-ladder, and hands one worker's typed output to the next via a function call. The constraint that made this right is that the user journey has exactly three product flows; the decomposition is knowable up front. The cost is fixed decomposition (no runtime adaptation) and synthesis-by-function-call instead of synthesis-by-LLM. To promote to an autonomous supervisor, see `../06-orchestration-system-design-templates/` — the workers stay the same; only the outer supervisor implementation changes.

- Supervisor-worker is the role, not the implementation — code can play the role (and does, in `route.ts`).
- The supervisor's three jobs (decompose, delegate, synthesize) are present in every flavor; only *who does the reasoning* changes.
- Tools-style keeps control at the supervisor (one trajectory, debuggable, context-bloat risk); handoff-style transfers control (fragmented trajectory, swarm-style failure modes).
- blooming insights' supervisor is `route.ts`'s `if`-ladder; it skips reasoning because the user journey is the decomposition.
- Worth it while the decomposition is finite and knowable; promote to LLM supervisor when the route file becomes a switchboard.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "do you have a supervisor agent" they're testing whether you can tell the difference between a *role* and an *implementation*. The strong signal is naming `route.ts` as the supervisor — code that plays the supervisor role — and explaining why a model isn't needed for the job. The weak signal is saying "no, we don't have a supervisor" when in fact you do (every multi-agent system has one — the question is what implementation).

### Likely questions

[mid] Q: What's a supervisor-worker pattern?

A: One central agent decomposes a task into sub-jobs, delegates each sub-job to a specialist worker agent, collects the workers' outputs, and synthesizes them into a final answer. In blooming insights the supervisor *role* is filled by `app/api/agent/route.ts` — it's an `if`-ladder in code, not an LLM. The workers are the four agent classes (`DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `MonitoringAgent`), each running `runAgentLoop` in `lib/agents/base.ts`.

Diagram:
```
  ┌─ supervisor ROLE ──────────┐
  │ decompose → delegate →     │
  │ synthesize                 │
  │ (in this codebase: route.ts│
  │  if-ladder, not an LLM)    │
  └──────┬──────────┬──────────┘
         ▼          ▼
       worker A   worker B
       (Diag.)    (Recomm.)
```

[senior] Q: Why didn't you make the supervisor an actual agent?

A: Because the supervisor's job is *decompose the user journey*, and the user journey has exactly three product flows — query, anomaly investigation, split-step recommend. That decomposition is knowable up front; encoding it as an `if`-ladder costs zero LLM calls and adds zero debug surface. An LLM supervisor would pay 1–3 extra seconds under our ~1 req/s MCP rate limit for every investigation to be told "diagnostic first, then recommendation" — a decision the route already knows. I'd promote to an LLM supervisor the day the route file became a switchboard with more cases than fit on screen.

Diagram:
```
  Chosen (code supervisor)        Alternative (LLM supervisor)
  ──────────────────────────      ──────────────────────────────
  ~50 lines in route.ts           supervisor prompt + own loop
  0 extra LLM calls               +1 LLM call / decision (~1–3s)
  2 suspects to debug             3 suspects to debug
  decomposition fixed at code     decomposition fluid at runtime
   time                            (extra power, extra cost)
```

[arch] Q: How would you bolt an LLM supervisor on top of the existing agents if a future requirement forced it?

A: The workers stay unchanged — `DiagnosticAgent.investigate`, `RecommendationAgent.propose`, etc. are already the right shape. The new code is a `SupervisorAgent` class that runs `runAgentLoop` with worker-as-tool schemas (each worker exposed as a tool with a typed input/output). The `route.ts` `if`-ladder gets replaced by a single call to `supervisor.run(userInput)`. The hardest part isn't the supervisor — it's the *synthesis*: the route's current synthesis is "stream worker A's events, then worker B's events" (function-call composition); an LLM supervisor wants to *merge* outputs into a single narrative, which can drift, contradict, or hallucinate. So I'd ship the supervisor with strict output validation (zod schemas on its synthesis turn) and probably keep `route.ts` for the streaming layer.

Diagram:
```
  ┌─ what stays ──────────────────────┐
  │ DiagnosticAgent.investigate(...)  │  (unchanged)
  │ RecommendationAgent.propose(...)  │  (unchanged)
  │ runAgentLoop in lib/agents/base.ts│  (unchanged)
  └───────────────────────────────────┘
  ┌─ what's new ──────────────────────┐
  │ SupervisorAgent class             │ ←
  │   ReAct loop with workers-as-tools│
  │   + zod synthesis schema          │
  └───────────────────────────────────┘
  ┌─ what changes ────────────────────┐
  │ route.ts if-ladder → one call to  │ ←
  │   supervisor.run(...)             │
  └───────────────────────────────────┘
```

### The question candidates always dodge

Q: You said `route.ts` is a "supervisor" — but it's just an `if`-ladder. Isn't calling that a supervisor a stretch?

A: It's not a stretch — it's the honest framing. Supervisor-worker is the *role*; whoever does decompose-delegate-merge is the supervisor, no matter what's in the box. The route does all three: it decomposes the user request (via the `insightId`/`q`/`step` query-string contract, where each combination corresponds to a sub-job), it delegates (picks the worker agent), and it synthesizes (the typed `Diagnosis` is handed to the next worker as a function arg, and the user-facing answer is the streamed concatenation of worker outputs). The thing it skips is *reasoning about each step* — but the role's three jobs are all present. The mistake would be to insist supervisor-worker requires an LLM, then claim the codebase "isn't really multi-agent" — when in fact it is, with the supervisor implemented as code. Naming this out loud is how you avoid the implicit-pretense that an `if`-ladder isn't doing a real job.

Diagram:
```
The supervisor role — present in both flavors

  ┌────────────────────────────────┐  ┌────────────────────────────────┐
  │ LLM supervisor (the "real" one)│  │ Code supervisor (route.ts)     │
  ├────────────────────────────────┤  ├────────────────────────────────┤
  │ decompose:  LLM reasons about  │  │ decompose:  query-string       │
  │   sub-jobs                     │  │   contract (insightId/q/step)  │
  │ delegate:   model picks worker │  │ delegate:   if-ladder picks    │
  │   by reasoning                 │  │   worker                       │
  │ synthesize: LLM merges outputs │  │ synthesize: function-call,     │
  │   into prose                   │  │   stream concatenation         │
  └────────────────────────────────┘  └────────────────────────────────┘
   same three jobs · different implementation
```

### One-line anchors

- "Supervisor-worker is a role, not an implementation — code can play it (and does, in `route.ts`)."
- "The route file decomposes, delegates, and synthesizes — it just doesn't reason. That's the deliberate choice."
- "Tools-style keeps one trajectory and one context window; handoff-style fragments both. We have neither — we have a code supervisor."
- "The day the route file becomes a switchboard, the LLM supervisor earns its overhead. Not before."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the supervisor-worker shape from memory: supervisor at the top, three workers below, arrows down for delegation and arrows up for results. Then draw the same shape with the supervisor labelled "code (if-ladder)" — that's the blooming insights version.

Open the file. Compare.

✓ Pass: the shape is the same in both diagrams; only the supervisor label changes
✗ Fail: re-read How it works Layer 1, wait 10 minutes, try again. Do not move on until you pass.

### Level 2 — Explain it out loud

Explain to a colleague who asked "wait, do you have a supervisor or not?" — answer in under 90 seconds without notes.

Checkpoints — did you:
- Name `app/api/agent/route.ts` as the supervisor (and clarify: it's code, not an LLM)?
- Name the supervisor's three jobs (decompose, delegate, synthesize) and walk through how the route does each?
- Name the tradeoff (no runtime adaptation, but no LLM cost and one less suspect to debug)?
- Name the breakpoint (when the route becomes a switchboard)?

If you skipped any: you described the architecture, you didn't defend the choice.

### Level 3 — Apply it to a new scenario

A product manager wants to add an "explain in plain English" agent that runs *after* recommendation and rewrites the recommendations for a non-technical reader. The PM also wants the system to *skip* the explain step if the recommendation confidence is high (the assumption: high-confidence recs are already clear).

Without looking at the file: does this change require an LLM supervisor, or can the route's `if`-ladder still express it? What would land in `route.ts` and what would land in a new agent class?

Write your answer (3–5 sentences). Then open `app/api/agent/route.ts` L244–L249 and check whether the recommendation block could be extended with another `if (lowConfidence) { await explainAgent.run(...) }`.

### Level 4 — Defend the decision you'd change

"If you were starting this project today and you knew the user journey would grow to 20+ anomaly types each needing a specialist worker, would you still use a code supervisor, or start with an LLM supervisor on day one? Why? If you'd switch, what's the minimum supervisor agent you'd ship — what tool schemas, what synthesis instruction — and which lines in `route.ts` would it replace?"

Reference the code: `route.ts` L199–L200 (lead-agent select), L224–L249 (pipeline), `lib/agents/base.ts` L48–L176 (`runAgentLoop`).

### Quick check — code reference test

Without opening any files:
- What file plays the supervisor role in blooming insights?
- What's the function that runs each worker's loop, and what file is it in?
- How is the diagnosis handed from the diagnostic worker to the recommendation worker — function call, LLM merge, message bus?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
