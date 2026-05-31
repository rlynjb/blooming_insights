# Supervisor-worker

**Industry name(s):** Supervisor-worker, manager-worker, orchestrator-workers, hub-and-spoke
**Type:** Industry standard · Language-agnostic

> The most common multi-agent topology — a central supervisor decomposes a task, delegates to specialist workers, synthesizes their results. blooming insights does NOT have an LLM supervisor; the route file is a *hard-coded* supervisor (code decomposes the user journey, picks the agent), which is the same shape with the supervisor role played by an `if`-ladder instead of a model.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Supervisor-worker is a *role* at the Pipeline coordinator band — whoever decomposes the task, picks the worker, and merges results. In blooming insights, that role is played by code, not a model: the supervisor IS `lib/agents/pipeline.ts` (and the `if`-ladder in `app/api/agent/route.ts` that picks which lead agent runs). The workers are the per-agent definitions one band below. The LLM-supervisor variant would replace the Pipeline band's owner with an agent that reasons about each next worker; the workers and the loop below stay identical either way.

```
  Zoom out — where the supervisor role lives

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts (entry-point if-ladder)  │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Pipeline coordinator ──▼────────────────────────┐  ← we are here
  │  ★ SUPERVISOR ROLE ★                              │
  │  Today (CODE supervisor):                         │
  │    lib/agents/pipeline.ts — sequential, no LLM    │
  │  Alternative (LLM supervisor):                    │
  │    a supervisor agent reasons each next worker    │
  │    (+1 loop, +1 budget, +1 debug suspect)         │
  └─────────────────────────┬────────────────────────┘
                            │  delegates to workers
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring | diagnostic | recommendation | query │
  │  (the workers — unchanged either way)             │
  └─────────────────────────┬────────────────────────┘
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop — each worker runs this            │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does the supervisor role need to be a model, and when can code play the same role? The shape is identical either way — decompose, delegate, merge — only the implementation changes. blooming insights has a supervisor; it just doesn't reason. Below, you'll see both flavors walked and why this codebase's order-is-knowable property lets code play the supervisor for free.

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

The condition under which this works: the supervisor's three jobs need to actually be the right framing for the problem. They are when the workers are *single-purpose specialists* and the problem genuinely decomposes. They aren't when the workers are *peers* that hand control to each other directly (that's swarm — covered in the swarm-handoff note).

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

The practical consequence: the trajectory is *fragmented* across multiple agent runs. Debugging is "find the right loop's trajectory, then the next one, then the next." Each agent's context window is fresh and small (a win), but the *narrative* of what happened is now distributed across loops. Failure modes from the swarm-handoff note (infinite handoff) start to apply.

The condition under which this works: each worker is large enough (or specialized enough) that running it as a sub-tool inside the supervisor's window would explode context, AND the order of workers genuinely depends on what one worker emits.

### Phase A vs Phase B — the route as a supervisor that does not reason

Right now in blooming insights, the supervisor role exists — it's played by code. Here's what would change if a future quality requirement forced it to become an agent.

```
        Now (route as code supervisor)        If quality forced it (LLM supervisor)
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ route handler's if-ladder           │  │ a new supervisor agent class        │ ←
│   if q AND no insightId             │  │   shared agent loop with            │
│     → query agent                   │  │   worker-as-tool schemas for        │
│   else step == 'recommend'          │  │   diagnostic / recommendation /     │
│     → recommendation agent          │  │   query                             │
│   else                              │  │                                     │
│     → diagnostic agent              │  │ supervisor decides ORDER at runtime │
│       then recommendation agent     │  │ (skip, loop, re-order)              │
│   ▼                                 │  │   ▼                                 │
│ workers are unchanged               │  │ workers are unchanged                │ ←
│ (diagnostic.investigate, etc.)      │  │ (same agent classes, same loops)    │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   the WORKERS don't change in either phase — only the
   supervisor's implementation moves from code to model
```

*Now:* the supervisor is the route handler's `GET` body. It decomposes the request via query-string fields (an insightId, a free-form q, a step), picks the worker by if-ladder, hands the typed diagnosis from one worker to the next via a function call, and "synthesizes" by streaming workers' outputs to the client in order. The decomposition is hard-coded because the user *journey* is the decomposition: there are exactly three product flows.

*If quality forced it:* the day the user journey isn't expressible as 3 product flows — e.g. when "anomaly type" branches into 20 specialist worker agents and the route file becomes a switchboard — a supervisor agent earns its overhead. The workers (diagnostic, recommendation, etc.) don't change at all; only the *outer* implementation of decompose-delegate-merge moves from code to a model.

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
  │   route handler (no LLM in the supervisor role)              │
  │   ┌────────────────────────────────────────────────────┐     │
  │   │ if q AND no insightId    → query agent             │     │
  │   │ else step == 'recommend' → recommendation agent    │     │
  │   │ else                     → diagnostic agent +      │     │
  │   │                            recommendation agent    │     │
  │   └─────────────────┬──────────────────────────────────┘     │
  │                     ▼                                        │
  │   workers (diagnostic, recommendation, …)                    │
  │   are ReAct loops — but the supervisor is code               │
  │                                                              │
  │   trajectory: ONE per worker; the route streams them         │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

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

## See also

→ `./01-when-not-to-go-multi-agent.md` · → `./03-sequential-pipeline.md` · → `./06-swarm-handoff.md` · → `../06-orchestration-system-design-templates/` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → routing primitive: `../01-reasoning-patterns/01-chains-vs-agents.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
