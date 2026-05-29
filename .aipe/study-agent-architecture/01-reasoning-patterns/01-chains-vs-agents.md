# Chains vs agents (the boundary)

**Industry name(s):** Workflow vs autonomous agent, deterministic orchestration vs ReAct loop, control-flow-in-code vs control-flow-in-model
**Type:** Industry standard · Language-agnostic

> The dividing line between steps an engineer wrote and steps a model decides at runtime. blooming insights sits on BOTH sides of this line at once: the route file picks the next agent (a chain), and each agent loops over tools on its own (an agent) — and the boundary between them is live in the same request.

**See also:** → 02-react.md · → 06-routing.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` · → `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---

## Why care

You've built a multi-step form. Step 1 collects an email, step 2 collects a name, step 3 confirms. The order is hardcoded in your component: `if (step === 1) … else if (step === 2) …`. You wrote the transitions. The form fills in *values*, but it never decides to skip step 2 or invent a step 4 — the path is yours, baked into the JSX, the same every time.

Now picture a different shape. A `.then()` chain where each link decides whether the *next* link should even run, and which one — based on what it just saw. `fetchUser().then(u => u.isPremium ? loadDashboard() : loadUpsell())`. The branch isn't fixed; it depends on the data. Push that all the way: a loop where the code doesn't know how many `.then()`s there will be, because each step reads its result and *chooses the next call* until it decides it's done.

That second shape is the question this file answers: **when does control flow live in your code (a chain) versus in the model at runtime (an agent)?** Not "is there an LLM" — both have one. The line is who writes the steps. In a chain, the engineer writes the step order and the LLM fills each slot. In an agent, the model writes the step order as it goes.

**Why answering that question matters:** because the two shapes fail in opposite ways, and you debug them with opposite tools. A chain that breaks broke at a *known* step — you look at step 2's code. An agent that breaks chose a *wrong path* — you replay its trajectory to find where the reasoning went off. Mislabel which one you have and you debug the wrong thing: you grep route code for a bug that's actually in a prompt, or you tune a prompt for a bug that's actually a hardcoded `if`.

Without naming the boundary:
- A diagnosis comes back wrong
- You assume "the model picked the wrong agent" and start rewriting prompts
- But the route code (`route.ts`) is what picks diagnostic-then-recommendation — deterministically, every time
- You burned an afternoon on the wrong layer

With the boundary named:
- A diagnosis comes back wrong
- You ask: was this the *order* (chain — check `route.ts`) or the *investigation* (agent — replay `runAgentLoop`'s tool calls)?
- You go straight to the right layer

One-line summary: **a chain is a `.then()` chain you wrote; an agent is a `while` loop the model drives — and blooming insights runs a chain of agents, so it's both at once.** Here's how that plays out in the code.

---

## How it works

**The mental model: a chain of agents.** The outer shape is a fixed pipeline the route code wrote — monitoring, then diagnostic, then recommendation, in that order, every time. The inner shape, inside each stage, is an autonomous loop the model drives — reason, call a tool, read the result, repeat until done. The boundary is the seam between them: the route owns *which agent runs next*; the agent owns *what it does inside its turn*.

```
The boundary in one picture

  CHAIN (route.ts writes the order)
  ┌──────────┐      ┌──────────┐      ┌──────────────┐
  │monitoring│ ───► │diagnostic│ ───► │recommendation│
  └──────────┘      └────┬─────┘      └──────────────┘
   engineer-written order; the route picks the next stage
                         │
                         ▼  zoom into ONE stage
  AGENT (runAgentLoop, model drives)
  ┌─────────────────────────────────────────┐
  │  reason → call tool → observe → repeat   │
  │  the MODEL decides each next call & stop  │
  └─────────────────────────────────────────┘
```

The strategy in plain English: **fix the order where you know it, free the steps where you don't.** The order of the three analyst stages is knowable up front (you always detect before you diagnose, diagnose before you recommend), so the route hardcodes it. What each stage *does* — which EQL to run, when it has enough evidence — is not knowable up front, so each stage gets a loop.

### The chain half — control flow the engineer wrote

The technical thing: a *deterministic pipeline*. The next stage is selected by branching code, not by a model.

If you're coming from frontend, this is your multi-step form's `if (step === 1) … else if (step === 2)` — except the "steps" are whole agents. The route reads a `step` query param (`diagnose` or `recommend`) and a `q` param, and a plain `if`/`else` decides which agent constructor to call. No model is consulted about ordering.

```
route.ts — the chain is an if-ladder (not an LLM)

  q && !insightId   ──►  QueryAgent          (free-form question)
  step === 'recommend' ─►  RecommendationAgent (skip diagnose)
  else (diagnose)   ──►  DiagnosticAgent
                         then, if step !== 'diagnose':
                              RecommendationAgent

  the SUPERVISOR here is code — an if-ladder, not a model
```

The practical consequence: the diagnostic agent's output is handed to the recommendation agent by the *route*, not by either agent deciding to. In `route.ts` the diagnosis object flows `diagAgent.investigate(...)` → `recAgent.propose(inv, diagnosis!, ...)` — a function passing a return value to the next function, exactly like `a().then(x => b(x))`. (Across the two-step UI, the handoff is the client's `sessionStorage` key `bi:diag:<id>`, but the principle is identical: code carries the value, not a model.)

The condition under which this works: the order has to be genuinely fixed. It is here — there is no anomaly you'd recommend-before-you-diagnose. The moment the order needed to depend on what an agent found, this `if`-ladder would become an LLM supervisor (covered in `06-routing.md` and the multi-agent section).

### The agent half — control flow the model wrote

The technical thing: an *autonomous ReAct loop*. Inside one stage, the model emits a tool call, your code runs it, feeds the result back, and the model decides the next call — or decides to stop and answer.

If you're coming from frontend, this is a `.then()` chain whose *length you don't know in advance*, because each link inspects its result and picks the next call. You can't write `a().then(b).then(c)` because you don't know there will be exactly three, or that `b` comes after `a`. The model writes that chain at runtime.

```
runAgentLoop (base.ts L85) — the model writes the chain

  turn 0:  model: "check purchase volume"  → execute_analytics_eql
           observe: { count: 42000 }
  turn 1:  model: "revenue too — compare windows" → execute_analytics_eql
           observe: { current: 42000, prior: 51500 }
  turn 2:  model: no tool_use → DONE, emits JSON
           (base.ts L121: zero tool_use blocks = natural stop)

  the loop wrote itself — 3 turns this time, maybe 5 next time
```

The practical consequence: two runs of the same diagnostic agent on the same anomaly can take a different number of turns and call different tools, because the model re-decides after every observation. That's the upside (it adapts to what the data shows) and the cost (variable latency, variable token spend, a trajectory you have to replay to debug).

The condition under which it works — and the safety rail: an unbounded model-driven loop can run forever. `runAgentLoop` caps it two ways: `maxTurns` (default 8) and `maxToolCalls` (6 for monitoring/diagnostic/query, 4 for recommendation). When the budget is spent, the loop forces a final tool-less turn (`base.ts` L90–L101) — it strips the tools from the request so the model *must* produce an answer instead of another call.

### Phase A vs Phase B — where the boundary could move

Right now the boundary sits between the route (chain) and the agents (loops). It could move — and naming where surfaces the design choice.

```
        Now (chain of agents)            If quality forced it (LLM supervisor)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ route.ts if-ladder picks the │  │ a supervisor AGENT picks the next │ ←
│ next stage (deterministic)   │  │ stage at runtime (model-decided)  │
│   ▼                          │  │   ▼                               │
│ each stage = a ReAct loop    │  │ each stage = a ReAct loop         │
│   (model-driven)             │  │   (model-driven, unchanged)       │ ←
└──────────────────────────────┘  └──────────────────────────────────┘
   the inner loops are identical in both — only WHO picks the
   next stage changes (code → model)
```

*Now:* the order is fixed and the route enforces it. Cheap, fully debuggable, the order can't drift.

*If quality forced it:* if some anomalies needed to skip diagnosis, or loop diagnosis twice, or pick a fourth specialist, the `if`-ladder would become a supervisor agent that *reasons* about which stage runs next. The inner loops wouldn't change at all — only the outer control-flow owner moves from code to model.

The takeaway: **the inner agent loops don't have to change for the outer chain to become an agent.** That's the whole reason the boundary is worth naming — it's the one seam you'd move, and everything on either side of it stays put.

This is what people mean when they say "use a chain when you know the steps, an agent when you don't." blooming insights knows the *stage order* (chain it) but not the *queries inside a stage* (loop it). The boundary isn't a compromise; it's drawn exactly where the knowability changes.

The full picture is below.

---

## Chains vs agents — diagram

```
blooming insights: a chain of agents

  ┌─────────────────────── CHAIN LAYER (route.ts, code) ───────────────────────┐
  │                                                                             │
  │   ?q=  ──► classifyIntent ──► QueryAgent ──────────────┐                    │
  │                                                         │                   │
  │   ?insightId=  ──► resolveAnomaly                       │                   │
  │        │                                                │                   │
  │        ▼  (deterministic if-ladder; the CODE is the supervisor)            │
  │   ┌──────────┐   diagnosis    ┌──────────────┐                            │
  │   │diagnostic│ ─────────────► │recommendation│                            │
  │   └────┬─────┘   (route hands │              │                            │
  │        │          step2→step3) └──────┬───────┘                            │
  └────────│──────────────────────────────│──────────────────────────────────┘
           │ zoom in: each box is an...    │
           ▼                               ▼
  ┌─────────────────────── AGENT LAYER (runAgentLoop, model) ──────────────────┐
  │   ┌─────────┐                                                              │
  │   │ reason  │ ◄──────────────────────┐                                     │
  │   └────┬────┘                         │ observation fed back (base.ts L171)│
  │        ▼                              │                                     │
  │   ┌─────────┐   ┌──────────────┐      │                                     │
  │   │  act    │──►│ run MCP tool │ ─────┘   loop until: no tool_use (done)    │
  │   └─────────┘   └──────────────┘          OR budget spent → forced final    │
  │                                            turn (base.ts L90, tools removed) │
  └─────────────────────────────────────────────────────────────────────────────┘

  CHAIN owns the order of stages · AGENT owns what happens inside a stage
```

---

## In this codebase

**Chain half — the deterministic pipeline**
**File:** `app/api/agent/route.ts`
**Function / class:** the `GET` stream `start()` body
**Line range:** L199–L249 (lead-agent select L199–L200; query branch L210–L218; diagnostic→recommendation L224–L249)

The `if`-ladder picks the next agent. The diagnosis is passed from `diagAgent.investigate()` (L238) into `recAgent.propose(inv, diagnosis!, …)` (L247) — a return value handed to the next call. No model decides this order.

**Agent half — the autonomous loop**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L48–L176 (loop L85; natural stop on zero tool_use L121; observation fed back L171; budget/forced-final L90–L101)

All four agents (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) call this one loop. The model writes the step sequence inside it.

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
- Multi-agent orchestration (`../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`) → what the chain becomes when the order goes model-driven

---

## Tradeoffs

The decision here was *where to draw the boundary* — a deterministic route owning the stage order, autonomous loops owning the work inside each stage. The alternative most teams reach for is an LLM supervisor that decides the order too.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Chain-of-agents (chosen)    │ LLM supervisor (alternative)│
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build time       │ an if-ladder in route.ts    │ a supervisor prompt + its   │
│                  │ (~50 lines)                 │ own loop + handoff protocol │
│ Latency          │ stage order is free (no LLM)│ +1 model call per ordering  │
│                  │                             │ decision                    │
│ Debugging        │ order bug → read route.ts;  │ order bug → replay the      │
│                  │ work bug → replay one loop  │ supervisor's reasoning too  │
│ Complexity       │ two clear layers, one seam  │ a third reasoning layer to  │
│                  │                             │ reason about                │
│ Predictability   │ same order every run        │ order can drift run-to-run  │
│ Cost/run         │ pays for 3 agent loops only │ pays for loops + supervisor │
│                  │                             │ turns                       │
│ Failure blast    │ a bad stage fails alone     │ a confused supervisor mis-  │
│                  │                             │ routes the whole run        │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up runtime flexibility in the ordering. The route can't decide to skip diagnosis for a "trivial" anomaly or run diagnosis twice for a confusing one — the `if`-ladder in `route.ts` L224–L249 is fixed. If a new analyst flow needed a conditional fourth stage, that's a code change, not a prompt tweak.

We also gave up a small amount of "smart" routing inside the investigation. Every anomaly goes diagnostic → recommendation, even ones where the diagnosis is obvious. A supervisor might short-circuit those. We pay a fixed two-stage cost regardless.

### What the alternative would have cost

If we had built an LLM supervisor to own the stage order, the up-front cost would have been a whole extra reasoning layer: a supervisor prompt, its own `runAgentLoop`, and a handoff protocol between supervisor and workers. Every investigation would pay an extra model call (~1–3s under the ~1 req/s MCP limit) just to be told "diagnose first" — a decision we already know. And debugging would get harder: a wrong recommendation could now be the supervisor mis-ordering, the diagnostic mis-investigating, or the recommendation mis-proposing — three suspects instead of two.

### The breakpoint

This stays the right call until the stage order needs to depend on what a stage *found* — e.g. "if the diagnosis is inconclusive, route to a deep-dive specialist instead of recommendation." The day a stage's output has to change which stage runs next, the `if`-ladder can't express it cleanly and the supervisor earns its overhead.

### What wasn't actually a tradeoff

A single mega-agent with all tools was not a real alternative for the investigation flow. Cramming detect + diagnose + recommend into one prompt with one tool budget would blur the per-stage tool subsets (`lib/mcp/tools.ts`) and the per-stage caps that bound latency under the rate limit. The split into stages isn't a compromise — it's what makes the budgets per-job.

---

## Tech reference (industry pairing)

### Anthropic Messages API (tool use)

- **Codebase uses:** `@anthropic-ai/sdk`, `anthropic.messages.create({ tools, messages })` inside `runAgentLoop` (`lib/agents/base.ts` L102). Model `claude-sonnet-4-6` (L9).
- **Why it's here:** it's the engine of the agent half — the `tool_use` blocks it returns are how the model "writes the next step" of the loop.
- **Leading today:** Anthropic tool use — innovation-leading for agent loops, 2026.
- **Why it leads:** native `tool_use`/`tool_result` content blocks make the ReAct loop a first-class API shape; the model emits structured tool calls instead of you parsing free text.
- **Runner-up:** OpenAI function calling / Responses API — equivalent loop shape, the larger installed base.

### Next.js Route Handler (the chain layer)

- **Codebase uses:** an App Router route handler at `app/api/agent/route.ts`, `export async function GET` (L112), streaming NDJSON.
- **Why it's here:** the route handler IS the chain — its `if`-ladder is the deterministic supervisor that picks the next agent.
- **Leading today:** Next.js App Router handlers — adoption-leading for full-stack TS endpoints, 2026.
- **Why it leads:** co-locates the API with the app, runs on the edge or Node, and streams responses natively — the streamed trace is built on this.
- **Runner-up:** a standalone Hono/Express service — more control over the runtime, at the cost of a separate deploy.

---

## Summary

Chains vs agents is the question of who writes the steps: in a chain the engineer hardcodes the order and the LLM fills each slot; in an agent the model decides each next action at runtime. blooming insights is both — `route.ts` is a deterministic `if`-ladder that picks the next agent (monitoring → diagnostic → recommendation), and each agent is a `runAgentLoop` ReAct loop the model drives. The constraint that made this right is knowability: the *stage order* is fixed (so code owns it), but the *queries inside a stage* aren't (so the model owns them). The cost is fixed ordering — to make the route choose stages at runtime, you'd promote the `if`-ladder to an LLM supervisor and pay for a third reasoning layer.

- The boundary is one seam: `route.ts` owns the stage order; `runAgentLoop` owns what happens inside a stage.
- A chain bug lives in known code (read `route.ts`); an agent bug is a wrong path (replay the loop's tool calls) — name which you have before debugging.
- The diagnosis is handed step→step by the *route* (a return value, then `sessionStorage bi:diag:<id>`), not by an agent deciding to.
- The inner loops don't change if the outer chain ever becomes an LLM supervisor — that's why the boundary is the thing worth naming.
- Worth it while the stage order is knowable up front; promote to a supervisor only when a stage's output must change which stage runs next.

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

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the two-layer picture from memory: the chain layer (what picks the next stage) on top, one stage zoomed into the agent layer (the reason→act→observe loop) below. Label which layer is code and which is model.

Open the file. Compare.

✓ Pass: you put the `if`-ladder/order on the chain layer and the reason→tool→observe loop on the agent layer, and labelled code vs model
✗ Fail: re-read How it works, wait 10 minutes, try again. Do not move on until you pass.

### Level 2 — Explain it out loud
Explain "is this a chain or an agent" to a colleague who just asked "wait, which is it?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific files? → `app/api/agent/route.ts` (chain) and `lib/agents/base.ts` `runAgentLoop` (agent)
- Say why the order is in code, not in a model?
- Name the tradeoff (fixed order vs supervisor overhead) in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Can we make the system skip the recommendation stage when the diagnosis confidence is low, and instead re-run diagnosis with a deeper budget?" Without looking at the file: is that a change to the chain layer or the agent layer? What exactly would you touch, and which shape (code `if` vs model decision) does it become?

Write your answer (3–5 sentences). Then open `app/api/agent/route.ts` L224–L249 and check whether that `if`-ladder is where the change lands — and whether it stays an `if` or needs to read the diagnosis's confidence field.

### Level 4 — Defend the decision you'd change
"If you were building this today with the same ~1 req/s MCP limit and the same three-stage analyst flow, would you still hardcode the stage order in the route, or start with an LLM supervisor? Why? If you'd switch, what would the supervisor cost you per investigation, and which lines in `route.ts` would it replace?"

Reference the code: point to `route.ts` L224–L249 for what exists, and describe what a supervisor's own `runAgentLoop` would add.

### Quick check — code reference test
Without opening any files:
- What file holds the chain (the stage-order `if`-ladder)?
- What function holds the agent loop, and in what file?
- Roughly what line range is the diagnostic→recommendation handoff in the route?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
