# Chains vs agents (the boundary)

**Industry name(s):** Workflow vs autonomous agent, deterministic orchestration vs ReAct loop, control-flow-in-code vs control-flow-in-model
**Type:** Industry standard · Language-agnostic

> The dividing line between steps an engineer wrote and steps a model decides at runtime. blooming insights sits on BOTH sides of this line at once: the route file picks the next agent (a chain), and each agent loops over tools on its own (an agent) — and the boundary between them is live in the same request.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The chain/agent boundary in blooming insights sits exactly between two bands: the Route handler (which picks the next stage) and the Shared agent loop (which decides what happens inside a stage). Above the line, `route.ts` is a deterministic `if`-ladder — that's the chain half. Below the line, `runAgentLoop` is a model-driven ReAct loop — that's the agent half. The whole system is "a chain of agents," so this concept sits *on the seam*, not in any one band.

```
  Zoom out — where the chain/agent boundary lives

  ┌─ Route handler ─────────────────────────────────┐  ← chain half
  │  app/api/agent/route.ts                          │
  │  if-ladder picks monitoring → diagnostic →       │
  │  recommendation (CODE writes the order)          │
  └─────────────────────────┬────────────────────────┘
                            │  ★ THIS ★ — the boundary
                            ▼
  ┌─ Pipeline coordinator ──┴────────────────────────┐  ← we are here
  │  lib/agents/pipeline.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← agent half
  │  runAgentLoop (lib/agents/loop.ts)               │
  │  model writes the chain at runtime (ReAct)       │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: who writes the steps — your code or the model? On the chain side, the engineer wrote them; on the agent side, the model writes them as it goes. Naming where the line sits tells you which layer to debug when something goes wrong: a wrong *order* is a chain bug (look at `route.ts`), a wrong *investigation* is an agent bug (replay `runAgentLoop`'s trajectory). Below, you'll see both halves in code and the seam between them.

---

## Structure pass

**Layers.** Four layers stack from outside in: the **Route handler** (`app/api/agent/route.ts` — receives the HTTP request and reads the step), the **Pipeline coordinator** (a thin orchestrator that fires the agents in order), the **Per-agent definitions** (monitoring, diagnostic, recommendation, query — each one a system prompt + tool subset + handoff schema), and the **Shared agent loop** (`runAgentLoop` — the reason → act → observe cycle that drives one stage). The model itself sits one layer below as the actual decider inside the loop. The layers are stacked, not parallel — every request walks them top to bottom.

**Axis: control.** Who decides what happens next at each layer? This axis pops the seam because the whole concept of "chains vs agents" IS a control-flow question — code-decides vs model-decides is the only thing that separates one from the other. Cost is downstream of control (you pay for whatever decides), dependency is uniform (every layer calls the one below), and state is incidental. Control is the upstream lens.

**Seams.** Two seams matter, and the second one is THE seam this whole file is about. Seam 1 sits between the Route handler and the Pipeline coordinator — control stays in CODE on both sides (an if-ladder calls a function that calls functions); the boundary is real but the axis doesn't flip. That makes it cosmetic for this concept. Seam 2 sits between the Pipeline coordinator (and the per-agent wrapper) and the Shared agent loop — control flips from CODE (engineer-written `if`-ladder, fixed monitoring → diagnostic → recommendation order) to MODEL (the agent decides which tool to call, in what order, when to stop). This is the load-bearing seam: it is literally the chain/agent boundary, and the whole file's job is to teach what lives on each side of it.

```
  Structure pass — Chains vs agents

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Route handler                                 │
  │  Pipeline coordinator                          │
  │  Per-agent definitions                         │
  │  Shared agent loop (runAgentLoop)              │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides what happens next?       │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Route ↔ Pipeline (CODE → CODE, flat)  │
  │  Seam 2: Pipeline ↔ Agent loop (CODE → MODEL)  │
  │          ★ load-bearing — this IS the concept  │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  Seam 2 — "who decides what happens next?" answered two ways

  ┌─ Pipeline coord ─┐    seam      ┌─ Agent loop ──┐
  │  CODE: if-ladder │ ═════╪═════► │ MODEL: ReAct  │
  │  picks the next  │   (it flips) │ picks the next│
  │  STAGE           │              │ TOOL CALL     │
  └──────────────────┘              └───────────────┘
         ▲                                     ▲
         └───── same axis (control), two answers ─┘
                → THIS is the chain/agent boundary
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

**The mental model: a chain of agents.** The outer shape is a fixed pipeline the route code wrote — monitoring, then diagnostic, then recommendation, in that order, every time. The inner shape, inside each stage, is an autonomous loop the model drives — reason, call a tool, read the result, repeat until done. The boundary is the seam between them: the route owns *which agent runs next*; the agent owns *what it does inside its turn*.

```
The boundary in one picture

  CHAIN (route handler writes the order)
  ┌──────────┐      ┌──────────┐      ┌──────────────┐
  │monitoring│ ───► │diagnostic│ ───► │recommendation│
  └──────────┘      └────┬─────┘      └──────────────┘
   engineer-written order; the route picks the next stage
                         │
                         ▼  zoom into ONE stage
  AGENT (shared agent loop, model drives)
  ┌─────────────────────────────────────────┐
  │  reason → call tool → observe → repeat   │
  │  the MODEL decides each next call & stop  │
  └─────────────────────────────────────────┘
```

The strategy in plain English: **fix the order where you know it, free the steps where you don't.** The order of the three analyst stages is knowable up front (you always detect before you diagnose, diagnose before you recommend), so the route hardcodes it. What each stage *does* — which query to run, when it has enough evidence — is not knowable up front, so each stage gets a loop.

### The chain half — control flow the engineer wrote

The technical thing: a *deterministic pipeline*. The next stage is selected by branching code, not by a model.

If you're coming from frontend, this is your multi-step form's `if (step === 1) … else if (step === 2)` — except the "steps" are whole agents. The route handler reads a step query param (`diagnose` or `recommend`) and a free-form `q` param, and a plain if/else decides which agent to construct. No model is consulted about ordering.

**Where this lives in the repo.** File `app/api/agent/route.ts`, inside the `GET` stream `start()` body — L199–L249. The lead-agent select is L199–L200; the query branch is L210–L218; the diagnostic→recommendation handoff is L224–L249. The diagnosis flows out of `diagAgent.investigate()` at L238 and into `recAgent.propose(inv, diagnosis!, …)` at L247 — a function return value handed straight to the next call, with no model in between.

```
route handler — the chain is an if-ladder (not an LLM)

  q AND no insightId   ──►  query agent           (free-form question)
  step == 'recommend'  ──►  recommendation agent  (skip diagnose)
  else (diagnose)      ──►  diagnostic agent
                            then, if step != 'diagnose':
                                 recommendation agent

  the SUPERVISOR here is code — an if-ladder, not a model
```

The practical consequence: the diagnostic agent's output is handed to the recommendation agent by the *route*, not by either agent deciding to. The diagnosis object flows out of `investigate(...)` and into `propose(inv, diagnosis, ...)` — a function passing a return value to the next function, exactly like `a().then(x => b(x))`. (Across the two-step UI, the handoff is a client-side session-storage key, but the principle is identical: code carries the value, not a model.)

The condition under which this works: the order has to be genuinely fixed. It is here — there is no anomaly you'd recommend-before-you-diagnose. The moment the order needed to depend on what an agent found, this if-ladder would become an LLM supervisor (covered in the routing section and the multi-agent section).

### The agent half — control flow the model wrote

The technical thing: an *autonomous ReAct loop*. Inside one stage, the model emits a tool call, your code runs it, feeds the result back, and the model decides the next call — or decides to stop and answer.

If you're coming from frontend, this is a `.then()` chain whose *length you don't know in advance*, because each link inspects its result and picks the next call. You can't write `a().then(b).then(c)` because you don't know there will be exactly three, or that `b` comes after `a`. The model writes that chain at runtime.

**Where this lives in the repo.** File `lib/agents/base.ts`, function `runAgentLoop()` — L48–L176. The loop starts at L85; the natural stop on zero `tool_use` blocks is at L121; the observation gets fed back at L171; the budget check and forced-final-turn (tools stripped from the request) sit at L90–L101. All four agents — `monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts` — call this one loop; the model writes the step sequence inside it.

```
shape (not full impl):
  // CHAIN (route.ts): engineer-written order
  const diagnosis = await diagAgent.investigate(anomaly, hooks);
  const recs = await recAgent.propose(anomaly, diagnosis, hooks); // route hands it over

  // AGENT (base.ts): model-written order
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anthropic.messages.create({ tools, messages });
    if (noToolUse(res)) return finalText;        // model decided to stop
    messages.push(runToolsAndCollect(res));      // observation → next turn
  }
```

```
shared agent loop — the model writes the chain

  turn 0:  model: "check purchase volume"  → run analytics tool
           observe: { count: 42000 }
  turn 1:  model: "revenue too — compare windows" → run analytics tool
           observe: { current: 42000, prior: 51500 }
  turn 2:  model: no tool_use block → DONE, emits JSON
           (zero tool_use blocks = natural stop)

  the loop wrote itself — 3 turns this time, maybe 5 next time
```

The practical consequence: two runs of the same diagnostic agent on the same anomaly can take a different number of turns and call different tools, because the model re-decides after every observation. That's the upside (it adapts to what the data shows) and the cost (variable latency, variable token spend, a trajectory you have to replay to debug).

The condition under which it works — and the safety rail: an unbounded model-driven loop can run forever. The shared agent loop caps it two ways: a per-loop turn limit (default 8) and a per-loop tool-call limit (6 for monitoring/diagnostic/query, 4 for recommendation). When the budget is spent, the loop forces a final tool-less turn — it strips the tools from the request so the model *must* produce an answer instead of another call.

### Phase A vs Phase B — where the boundary could move

Right now the boundary sits between the route (chain) and the agents (loops). It could move — and naming where surfaces the design choice.

```
        Now (chain of agents)            If quality forced it (LLM supervisor)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ route if-ladder picks the    │  │ a supervisor AGENT picks the next │ ←
│ next stage (deterministic)   │  │ stage at runtime (model-decided)  │
│   ▼                          │  │   ▼                               │
│ each stage = a ReAct loop    │  │ each stage = a ReAct loop         │
│   (model-driven)             │  │   (model-driven, unchanged)       │ ←
└──────────────────────────────┘  └──────────────────────────────────┘
   the inner loops are identical in both — only WHO picks the
   next stage changes (code → model)
```

*Now:* the order is fixed and the route enforces it. Cheap, fully debuggable, the order can't drift.

*If quality forced it:* if some anomalies needed to skip diagnosis, or loop diagnosis twice, or pick a fourth specialist, the if-ladder would become a supervisor agent that *reasons* about which stage runs next. The inner loops wouldn't change at all — only the outer control-flow owner moves from code to model.

The takeaway: **the inner agent loops don't have to change for the outer chain to become an agent.** That's the whole reason the boundary is worth naming — it's the one seam you'd move, and everything on either side of it stays put.

This is what people mean when they say "use a chain when you know the steps, an agent when you don't." blooming insights knows the *stage order* (chain it) but not the *queries inside a stage* (loop it). The boundary isn't a compromise; it's drawn exactly where the knowability changes.

The full picture is below.

---

## Chains vs agents — diagram

```
blooming insights: a chain of agents

  ┌─────────────────────── CHAIN LAYER (route handler, code) ──────────────────┐
  │                                                                             │
  │   ?q=  ──► classify intent ──► query agent ────────────┐                    │
  │                                                         │                   │
  │   ?insightId=  ──► resolve anomaly                      │                   │
  │        │                                                │                   │
  │        ▼  (deterministic if-ladder; the CODE is the supervisor)            │
  │   ┌──────────┐   diagnosis    ┌──────────────┐                            │
  │   │diagnostic│ ─────────────► │recommendation│                            │
  │   └────┬─────┘   (route hands │              │                            │
  │        │          step2→step3) └──────┬───────┘                            │
  └────────│──────────────────────────────│──────────────────────────────────┘
           │ zoom in: each box is an...    │
           ▼                               ▼
  ┌─────────────────────── AGENT LAYER (shared agent loop, model) ─────────────┐
  │   ┌─────────┐                                                              │
  │   │ reason  │ ◄──────────────────────┐                                     │
  │   └────┬────┘                         │ observation fed back               │
  │        ▼                              │                                     │
  │   ┌─────────┐   ┌──────────────┐      │                                     │
  │   │  act    │──►│ run MCP tool │ ─────┘   loop until: no tool_use (done)    │
  │   └─────────┘   └──────────────┘          OR budget spent → forced final    │
  │                                            turn (tools removed)             │
  └─────────────────────────────────────────────────────────────────────────────┘

  CHAIN owns the order of stages · AGENT owns what happens inside a stage
```

---

## Elaborate

### Where this pattern comes from

The distinction got its sharpest framing from Anthropic's 2024 "Building Effective Agents" essay, which split "workflows" (LLMs orchestrated through predefined code paths) from "agents" (LLMs that dynamically direct their own process). The industry had been calling everything an "agent"; the essay's contribution was insisting that a prompt chain is *not* an agent, and that most production "agentic" systems are actually workflows — and are better for it.

### The deeper principle

Control flow is a thing you can place. It can live in your code (you write the `if`s) or in the model (it reasons about what's next). Neither is more advanced — they're a tradeoff between *predictability* and *adaptability*. The discipline is to push control flow into code wherever the path is knowable, and only hand it to the model where the path genuinely depends on runtime data.

```
  knowable path  ──► code owns control flow (chain)   ──► predictable, debuggable
  unknowable path──► model owns control flow (agent)  ──► adaptable, variable cost
```

### Where this breaks down

The chain breaks when the order stops being fixed — when "which stage next" depends on what a stage found. At that point the `if`-ladder becomes an LLM supervisor and you've crossed into multi-agent orchestration. The agent breaks when the task is actually deterministic: wrapping a fixed 3-step process in a ReAct loop pays the loop's variable-cost and debugging tax for adaptability you never use.

### What to explore next
- ReAct (`02-react.md`) → the specific shape of the loop inside each agent stage
- Routing (`06-routing.md`) → how the `?q=` path picks an agent — the chain's one model-decided edge
- Multi-agent orchestration (`../../study-system-design/06-multi-agent-orchestration.md`) → what the chain becomes when the order goes model-driven

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "is this an agent or a workflow," they're testing whether you can tell the difference under your own roof — and whether you over-reached for "agent" because it sounds impressive. The strong signal is showing you placed control flow deliberately: code where the path is known, model where it isn't. The weak signal is calling everything an "agent" because there's an LLM in it.

### Likely questions

[mid] Q: Is blooming insights a chain or an agent?

A: Both, at two layers. The route file is a chain — a deterministic `if`-ladder in `route.ts` picks monitoring → diagnostic → recommendation, the same order every time, no model consulted. Inside each stage is an agent — `runAgentLoop` is a ReAct loop where the model decides which tool to call and when to stop. So it's a chain of agents: code owns the stage order, the model owns the work inside a stage.

Diagram:
```
  route.ts (chain): monitoring ─► diagnostic ─► recommendation
                                      │
                                      ▼ each stage is...
  runAgentLoop (agent): reason → tool → observe → repeat
```

[senior] Q: Why didn't you let a supervisor agent decide the order?

A: Because the order is knowable up front — you always detect before diagnosing, diagnose before recommending; there's no anomaly you'd recommend-before-you-diagnose. A supervisor would pay an extra model call per investigation (1–3s under our ~1 req/s MCP limit) to be told something I already know, and it'd add a third suspect when a recommendation comes back wrong. I kept ordering in code and freedom inside the loop, where the queries genuinely aren't knowable. I'd promote to a supervisor the day a stage's output has to change which stage runs next.

Diagram:
```
   Chosen: code orders          Alternative: model orders
   if-ladder picks stage        supervisor reasons each time
   0 extra LLM calls            +1 LLM call / decision
   order can't drift            order can drift
```

[arch] Q: At 10x the anomaly volume, what breaks first — the chain or the agents?

A: The agents, not the chain. The `if`-ladder is free and stateless — it scales fine. The pressure point is the per-stage tool budget against the ~1 req/s MCP rate limit: more concurrent investigations means more concurrent agent loops all hitting the same MCP server. The first thing I'd add is fan-out backpressure (a concurrency limiter on agent loops) and cross-run caching of repeated EQL sub-steps — both serving concerns on the agent layer. The chain layer wouldn't change.

Diagram:
```
  ┌ Chain layer (route if-ladder) ── fine, stateless ─────┐
  ┌ Agent layer (runAgentLoop ×N) ◄─ BREAKS: N loops vs   │
  │                                  1 req/s MCP limit     │
  └ MCP server ◄──────────────────── shared bottleneck ───┘
```

### The question candidates always dodge
Q: If the order is hardcoded anyway, why bother with agents at all — why not make the whole thing a fixed chain of LLM calls with no loop?

A: Because the *order* of stages is knowable but the *work inside a stage* is not. A diagnostic investigation might need two EQL queries or five, in an order that depends on what the first query returns — I can't write that as a fixed chain because I don't know the length or the branches until the data comes back. So the loop is doing real work: it lets the model write the query sequence at runtime. What I *didn't* do is let the model write the *stage* sequence, because that one I do know. The honest version: I used a chain for the part I could predict and an agent for the part I couldn't, and I can point at exactly which lines own each (`route.ts` L224–L249 for the chain, `base.ts` L85 for the loop). The mistake would have been picking one shape for the whole system.

Diagram:
```
  What's fixed (chain it)        What's variable (loop it)
  ┌─────────────────────┐        ┌─────────────────────────┐
  │ stage order:         │        │ queries in a stage:      │
  │ detect→diag→recommend│        │ 2? 5? which EQL? depends │
  │ KNOWN up front       │        │ on prior result — UNKNOWN│
  └─────────────────────┘        └─────────────────────────┘
       route.ts if-ladder              runAgentLoop
```

### One-line anchors
- "It's a chain of agents — code owns the stage order, the model owns the work inside each stage."
- "I placed control flow where the path is known and handed it to the model only where it isn't."
- "A chain bug is in known code; an agent bug is a wrong path — I name which one before I debug."
- "The order is fixed because it's knowable, not because I couldn't make it dynamic — I'd promote to a supervisor the day a stage's output had to change the order."

---

## See also

→ 02-react.md · → 06-routing.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` · → `../../study-system-design/06-multi-agent-orchestration.md`

---
