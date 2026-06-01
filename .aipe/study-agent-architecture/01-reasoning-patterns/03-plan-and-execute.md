# Plan-and-execute

**Industry name(s):** Plan-and-execute, plan-then-solve, decomposition-then-execution, multi-step planner
**Type:** Industry standard · Language-agnostic

> Separate the planning model from the execution model — one expensive call decides the route, many cheap calls walk it. blooming insights does NOT use this pattern as a runtime *phase*; the monitoring prompt bakes a static "suggested query plan" into the system prompt, which is a degenerate plan-in-prompt, not plan-and-execute proper.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Plan-and-execute would sit *above* the Shared agent loop — a separate planner-model call producing a JSON plan that the loop then walks as an executor. In blooming insights, that planner phase does not exist; the Pipeline coordinator goes straight from "which agent runs" into `runAgentLoop` and the model decides every turn from there. The closest thing to a plan in this codebase is a static "Suggested query plan" section baked into the monitoring system prompt at `lib/agents/prompts/monitoring.md` L39–L47 — the plan went into a prompt, not into a phase.

```
  Zoom out — where plan-and-execute WOULD live

  ┌─ Pipeline coordinator ──────────────────────────┐  ← we are here
  │  lib/agents/pipeline.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Planner (would-be) ────▼────────────────────────┐  ← ★ THIS ★ (absent)
  │  ★ separate model call: emits JSON plan ★         │
  │  ── absent in blooming insights ──                │
  └─────────────────────────┬────────────────────────┘
                            │  plan as data
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring.md L39–L47 — "Suggested query plan"   │
  │  is the degenerate plan-in-prompt analog          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop — would become a step executor      │
  │  today: it's pure ReAct, model decides each turn  │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does separating the planner model from the executor model earn its overhead — and when is a single ReAct loop with a tight prompt enough? The breakpoint is whether the path is knowable up front. Monitoring's path IS knowable (same five EQL queries every workspace) so the plan went into the prompt; diagnostic and recommendation are NOT (each step depends on prior data) so they stay pure ReAct. Below, you'll see the three positions a codebase can take on this — and which one blooming insights sits at, and why.

---

## Structure pass

**Layers.** A would-be plan-and-execute setup needs four layers: the **Pipeline coordinator** (decides when to plan), a **Planner model call** (one expensive call that emits a structured JSON plan), the **Plan as data** (a list of step objects the executor consumes), and the **Executor loop** (walks the plan step by step, calling tools). In blooming insights only three of these exist — the Planner call layer is absent. The closest analog is the static "Suggested query plan" section baked into the monitoring system prompt, which lives at the Per-agent-definitions band and gets read by `runAgentLoop` (still ReAct, not a separate executor).

**Axis: control.** Who decides the route — a separate up-front model call, or the same model deciding turn by turn? This is the right axis because the entire distinction between plan-and-execute and ReAct lives in *where the routing decision happens* and *who makes it*. Cost is a real concern (the win is "one expensive call → many cheap calls") but cost is the *consequence* of the control choice, not its driver. Pick the wrong axis (say, dependency) and the would-be planner and the executor look identical — both call the model, both use tools.

**Seams.** Two seams are load-bearing in the WOULD-BE shape, and both are absent here. Seam 1 sits between the Pipeline coordinator and the Planner call — control flips from CODE (decides "now plan") to MODEL (decides the steps). Seam 2 sits between the Plan-as-data and the Executor loop — control flips from MODEL (already decided) back to CODE (walks the array). That second seam is the load-bearing one because it's what makes the executor cheap (it iterates a list, it doesn't reason about route). In blooming insights, both seams collapse: the "plan" is engineer-written prose in a system prompt (CODE on both sides of seam 1) and the executor is `runAgentLoop` re-deciding every turn (no flip at seam 2). That collapse is precisely what makes this a Case B file — the seams describe what isn't there, and the absence is the lesson.

```
  Structure pass — Plan-and-execute (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Pipeline coordinator                          │
  │  Planner model call (would-be — absent here)   │
  │  Plan-as-data (a list of step objects)         │
  │  Executor loop (walks the list)                │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides the route, up front or   │
  │           turn by turn?                        │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Coordinator ↔ Planner                 │
  │          (CODE → MODEL) — absent in this repo  │
  │  Seam 2: Plan-as-data ↔ Executor               │
  │          (MODEL → CODE) ★ load-bearing —       │
  │          this is what makes the executor cheap │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it (and the specific reason both seams collapsed into a prompt section instead).

---

## How it works

**The mental model: split the model that picks the route from the model that walks it.** A planner sees the task once, returns an ordered list of steps. An executor walks the list — usually a cheaper/faster model — calling tools per step. The planner is expensive and called once; the executor is cheap and called many times. The split is the win and the brittleness at the same time.

```
The split — one plan call, N execute calls

  task ──► ┌──────────────────────────┐
           │ PLAN (expensive model)    │  produces:
           │ "list the steps"          │   [step1, step2, step3]
           └──────────────┬────────────┘
                          │ plan as data
                          ▼
           ┌──────────────────────────┐
           │ EXECUTE (cheap model)     │  for each step:
           │ walk the plan            │    call tool, observe
           └──────────────────────────┘    (no re-planning)
```

The strategy in plain English: **decide once, execute many.** ReAct decides on every turn (which is why it scales token cost with depth). Plan-and-execute concentrates the decision-making in one call, then runs a much cheaper executor through the steps. The tradeoff is whether the plan survives contact with the data. blooming insights doesn't run a plan phase anywhere; the closest cousin is the *static "Suggested query plan" section* in the monitoring system prompt — a plan written by the engineer, baked into the prompt, the same for every run — which is plan-in-prompt, not plan-and-execute proper.

### Move 2.1 — The plan phase

The technical thing: a single LLM call whose output is structured — a list of step objects, each naming a tool and its inputs, possibly with dependencies between steps. Output schema is strict (JSON schema or a known shape), because the executor parses it as data.

If you're coming from frontend, this is the difference between writing `if (step === 1) handleEmail()` and writing `const steps = ['email', 'name', 'pay']; for (const s of steps) handle(s)`. The plan IS the array. Whoever writes the array — your code (static), or a model (dynamic) — owns the route.

```
Plan call output (the shape, not the impl)

  call model { model: "expensive", system: PLANNER_PROMPT,
               user: TASK }
  →  { plan: [
        { id: 1, tool: "analytics_query", args: {…},
          rationale: "establish baseline volume" },
        { id: 2, tool: "analytics_query", args: {…},
          depends_on: 1, rationale: "compare to prior window" },
        { id: 3, tool: "segmentation_query", args: {…},
          depends_on: [1, 2], rationale: "locate the change" }
     ] }
```

The practical consequence: the planner is the *expensive* part of the run. It reads the whole task context (schema, user intent, prior history) and writes the route — that's a long-context call. The executor only sees one step at a time, so its calls are short. The total budget shifts from "many big calls" (ReAct) to "one big call + many small ones."

The condition under which it works: the task is structured enough that a plan written *without seeing the data* is going to survive contact with the data. If the plan keeps going stale, you end up with re-planning, which collapses the whole win.

### Move 2.2 — The execute phase

The technical thing: an iterator over the plan's steps. For each step, the executor model receives the step's instructions plus prior steps' results, calls the named tool, and produces an observation. The executor doesn't re-decide the step order — it walks the plan.

If you're coming from frontend, this is `await Promise.all(steps.map(execute))` if the steps are independent, or `for await (const step of steps) await execute(step)` if they have dependencies. The control structure is back in your code; the model just fills slots.

```
Executor walking a plan — pseudocode

  results = {}
  for step in plan:
    ctx = { step, deps: deps(step).map(id => results[id]) }
    out = await executor.run(ctx, tools)   ← cheap model
    results[step.id] = out
  return synthesize(results)               ← optional final pass
```

The practical consequence: the executor's context per step is *just the step* — not the whole task. That's the cost win: cheap model + short context per call. It's also the failure window: if step 3 needs information that wasn't in step 2's result, the executor has no way to query "what does step 1 also have?" without escaping the plan.

The condition under which it works: the plan's step boundaries match the data dependencies. If a downstream step needs upstream information the plan didn't pass forward, you either (a) pre-pass everything (which negates the cheap-short-context win), or (b) re-plan (which negates the cheap-plan-once win).

### Move 2.3 — The re-plan trigger (the brittleness fix)

The technical thing: when an execution step fails or returns an unexpected shape, the runtime re-invokes the planner with the failure as input, asking for a revised plan from this point. Re-planning is the escape hatch when the plan didn't survive the data.

```
Re-plan on divergence

  step k executes → result diverges from plan's assumption
                          │
                          ▼
                ┌───────────────────────┐
                │ re-plan from step k:  │
                │ planner sees results  │  ← another expensive call
                │ 1..k-1 + failure k    │
                └────────────┬──────────┘
                             ▼
                  new plan: [step k', step k+1', …]
                  (executor resumes)
```

The practical consequence: every re-plan is another expensive planner call. The whole "decide once" win was the discipline of *not* re-planning; once you start, the budget can blow up. Production systems cap re-plans (typically 1–2 per run) and treat exceeding the cap as a "this task isn't plannable, hand off to human / route to ReAct" signal.

### Move 2.4 — Where blooming insights actually sits (Case B with nuance)

Honest read: this codebase does *not* run a plan phase. There is no separate planner call. All four agents go straight into ReAct via the shared agent loop. Pre-execution, the only thing that happens is intent classification on the `?q=` free-form path (a tiny cheap-model call that picks an agent — that's *routing*, not planning).

But there's a *degenerate* plan-in-prompt to name: the monitoring agent's system prompt contains a literal section called **"## Suggested query plan (~5 calls, global)"** listing the five queries the agent should run, in order. That's a plan — written by the engineer, baked into the prompt, the same for every run. The model then executes it inside a normal ReAct loop bounded by its tool-call budget.

```
Plan-and-execute proper          What the monitoring prompt does
─────────────────────            ─────────────────────────────────
runtime plan call                static plan in the prompt
plan is task-specific            plan is identical across all runs
re-plan on failure               no re-plan — the loop just adapts
2 model calls (plan + execute)   1 model call per turn (loop only)
```

So the right way to characterize it: blooming insights replaced the *plan phase* with a *plan section in the system prompt*. That's a deliberate choice — the steps for monitoring really are knowable up front (you always check purchase volume first, then revenue, then conversion, then traffic), so a runtime planner would re-derive a list that's already known. The cost saved is one expensive planner call per scan; the cost paid is that the plan is static and can't adapt per workspace.

```
The trade visualised

  Plan-and-execute proper       Plan in the prompt (this repo)
  ┌──────────────┐               ┌──────────────────────────┐
  │ planner call │ ◄── expensive │ "Suggested query plan:"  │ ◄── free
  └──────┬───────┘                │  1. count event purchase…│
         │                        │  2. count 180d window…   │
         ▼                        │  3. funnel counts…       │
  ┌──────────────┐               └──────────┬───────────────┘
  │ execute loop │                          │
  └──────────────┘                          ▼
                                  ┌──────────────────┐
                                  │ shared loop      │ ◄── one model
                                  │ executes the plan│      call per turn
                                  └──────────────────┘
```

The principle: **a plan only earns its phase when the steps depend on per-run inputs you can't enumerate ahead of time.** Monitoring's steps don't — every workspace gets the same 90-day-vs-prior-90-day comparison on the same four metrics. So the plan went into the prompt, not into a phase. The day a workspace's monitoring depends on per-workspace inputs the prompt can't enumerate, the plan would have to become dynamic — and at that point it's a runtime planner call.

The full picture is below.

---

## Plan-and-execute — diagram

```
The three positions you can take

  POSITION A: pure ReAct (what diagnostic + recommendation + query do)
  ┌──────────────────────────────────────────────────────────────┐
  │  user prompt ──► shared loop (model decides every turn)       │
  │                  per-turn cost grows with depth               │
  └──────────────────────────────────────────────────────────────┘

  POSITION B: plan in the prompt (what monitoring does)
  ┌──────────────────────────────────────────────────────────────┐
  │  user prompt ──► shared loop                                  │
  │                  │ system prompt CONTAINS the plan            │
  │                  │ (5-step "suggested query plan" section)    │
  │                  │ model walks it (mostly) — one model call    │
  │                  │ per turn                                    │
  └──────────────────────────────────────────────────────────────┘

  POSITION C: plan-and-execute proper (NOT in this codebase)
  ┌──────────────────────────────────────────────────────────────┐
  │  user prompt                                                  │
  │      │                                                         │
  │      ▼                                                         │
  │  ┌──────────┐  plan (JSON)  ┌────────────────┐                │
  │  │ planner  │ ────────────► │ executor loop  │                 │
  │  │(expense) │                │ (cheap, per-   │                 │
  │  └──────────┘                │  step calls)   │                 │
  │                              └────────────────┘                 │
  │  +1 expensive call up-front, +1 per re-plan                    │
  └──────────────────────────────────────────────────────────────┘

  This repo sits at A for 3 agents, B for monitoring.
  The breakpoint to C is: per-run inputs the prompt can't enumerate.
```

---

## Implementation in codebase

**Not yet implemented (Case B with nuance).** No agent has a separate planner call. The closest thing is the *static* "Suggested query plan" section in monitoring's system prompt.

**Closest existing surface — the static plan in the monitoring prompt**
**File:** `lib/agents/prompts/monitoring.md`
**Section:** `## Suggested query plan (~5 calls, global)`
**Line range:** L39–L47 — five EQL queries with their roles, then a "Derive:" line at L47 naming what to compute from the results

This plan is identical across every monitoring scan. The MonitoringAgent (`lib/agents/monitoring.ts` L69–L120) hands it to the model as part of the system prompt and runs a normal ReAct loop (`runAgentLoop`, `lib/agents/base.ts` L48–L176) with `maxToolCalls: 6` over it. The model walks the plan with some adaptation (it's allowed to shift the time window if data is empty per L31–L37 of the prompt) but it doesn't write its own plan.

**Why the project sits here and not at a runtime planner**

The monitoring task's steps are knowable up front — every workspace gets the same 90d-vs-prior-90d comparison on the same four metrics (purchase volume, revenue, funnel conversion, traffic). The diagnostic and recommendation tasks' steps are *not* knowable up front — the EQL depends on what the prior step's data showed — so they're pure ReAct, not plan-and-execute. A runtime planner would buy nothing here that the prompt doesn't already give for free.

```
shape (what a runtime planner WOULD add — illustrative, not in repo):

  // PHASE 1 — plan (hypothetical, not present in this repo)
  const plan = await planner.create({
    model: 'claude-opus-4',                // expensive
    system: PLANNER_PROMPT,
    messages: [{ role: 'user', content: anomaly }],
  });
  // PHASE 2 — execute (would replace runAgentLoop)
  for (const step of plan.steps) {
    const result = await executor.create({
      model: 'claude-haiku-4-5',           // cheap
      system: EXECUTOR_PROMPT,
      messages: [{ role: 'user', content: step }],
      tools: filterToolSchemas(allTools, step.allowedTools),
    });
    results[step.id] = result;
  }
```

---

## Elaborate

### Where this pattern comes from

The pattern got its sharpest framing from the LangChain "Plan-and-Execute" / BabyAGI / ReWOO line of work in 2023, which observed that the per-turn re-decision cost in pure ReAct grew with context length, and that on structured tasks a single planner call beat N planning-inside-each-turn calls. The plan-then-execute split moved budget from the executor (now cheap and short-context) to the planner (now expensive but one-shot), and the framing became standard in agent-orchestration libraries.

### The deeper principle

Decision-making concentrates well *when the task is decomposable in a way that survives contact with the data*. Pure ReAct trades that concentration for adaptability — every turn re-decides because every turn might learn something the prior plan didn't anticipate. Plan-and-execute trades adaptability for concentration. The discipline is to ask which side of that trade your task lives on, and to *put the plan where it costs least*: in your code if it's hardcoded, in a prompt if it's stable-but-templated, in a runtime call only if it must be per-run.

```
   Where the plan lives           Cost              Per-run adaptability
   ─────────────────────          ──────            ────────────────────
   in your code (a chain)         $0                none
   in the prompt (this repo's     prompt tokens     low (model can deviate)
     monitoring)                                    within the loop
   in a runtime planner call      +1 expensive      high
     (true plan-and-execute)       call per run
   re-planned on divergence       N expensive       very high
                                    calls per run
```

### Where this breaks down

When the plan can't anticipate divergences, you end up re-planning constantly and the whole "decide once" win collapses. When the steps' dependencies are tight enough that the executor needs almost all prior context anyway, the cheap-short-context-per-step assumption fails — you end up passing the full state to every step and paying near-ReAct token cost without ReAct's adaptability. When the task is small enough (3–5 tool calls), the planner's overhead is a larger share of the run than the savings on the executor side.

### What to explore next
- `02-react.md` → the baseline this pattern escalates from
- `04-reflexion-self-critique.md` → the other common escalation: instead of planning the route, critique the result
- `06-routing.md` → routing is one-shot decomposition (which agent) where plan-and-execute is N-step decomposition (which sequence of tools)
- `../../study-prompt-engineering/03-prompts-as-code.md` → how a static plan in a prompt earns its keep when the steps are stable

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks about plan-and-execute, they're testing whether you reach for it reflexively or whether you can name *when* it earns its overhead. The strong signal is "I considered it, here's where it would have helped, here's why my task doesn't need it." The weak signal is "yes I added a planner because good systems plan."

### Likely questions

[mid] Q: Does your monitoring agent use a planner?

A: Not as a runtime phase — there's no separate model call that produces a plan. The plan lives in the system prompt at `lib/agents/prompts/monitoring.md` L39–L47 as a "Suggested query plan" section listing the five EQL queries the agent should run. The `MonitoringAgent` (`lib/agents/monitoring.ts`) hands that prompt to `runAgentLoop` and the loop walks it like any ReAct loop, bounded by `maxToolCalls: 6`. One model call, one budget — the plan is just a section in the prompt.

Diagram:
```
  Prompt (static plan)     →  runAgentLoop (executes it)
  "Suggested query plan:        model decides each step
   1. count event purchase…      within the prompt's frame
   2. … 180d window…             1 LLM call per turn
   3. funnel counts…             6-call budget"
   4. session_start (traffic)
   5. (spare)"
```

[senior] Q: Why didn't you separate planner and executor for the diagnostic agent — wouldn't that be cleaner?

A: Because the diagnostic agent's steps depend on what the prior query returned. A planner up front would write `[check time series, check segments, check campaigns]` — three reasonable steps that almost never survive contact with the data. Real diagnostics need the second EQL to use values from the first (e.g. "the prior window had ~50k purchases, so investigate by country only on top-5"). That's pure ReAct's strength — per-turn re-decision with full observation history. A planner that re-plans on every divergence collapses into a more expensive ReAct.

Diagram:
```
   Plan-and-execute fits:        ReAct fits:
   stable steps, per-step ctx    each step's choice depends
   stays small, plan survives    on prior step's data,
   data                          full history needed each turn

   monitoring ◄── plan-in-       diagnostic ◄── pure ReAct
   prompt is enough              (this repo)
```

[arch] Q: At 100x the workspace count, would the static plan in monitoring still hold?

A: Probably not — that's the breakpoint. The plan in the prompt assumes every workspace cares about the same four metrics (purchase volume, revenue, funnel conversion, traffic). At scale, workspaces would diverge enough (multi-vertical retailers, B2B vs B2C, custom KPIs) that one prompt couldn't enumerate all the cases without ballooning. At that point a runtime planner that reads the workspace schema + the user's tracked KPIs and writes a per-workspace plan starts to earn its keep — one expensive call per scan is cheap relative to the wasted-coverage cost of running irrelevant queries across thousands of workspaces. The fix would be: a planner-phase model call that returns a JSON plan, and `runAgentLoop` becomes an executor that walks it.

Diagram:
```
  Today (one prompt fits all)        Scale (per-workspace plan)
  ┌──────────────────┐               ┌──────────────────┐
  │ monitoring.md    │               │ planner call     │
  │ 5-step plan      │   ─────►      │ reads schema +   │
  │ (same for all)   │  100x scale   │ KPIs, emits plan │
  └──────────────────┘               └────────┬─────────┘
       │                                       │ JSON plan
       ▼                                       ▼
  runAgentLoop                            runAgentLoop
  (executes prompt)                       (executes JSON plan)
```

### The question candidates always dodge
Q: If you call the plan in the prompt "plan-and-execute," isn't that just rebranding ReAct so you sound more sophisticated?

A: Honest answer: yes — and that's why I don't call it plan-and-execute. The plan in `monitoring.md` is a static section of the system prompt, not a runtime phase. There's exactly one model call per turn in `runAgentLoop`, and the same call site (`base.ts` L102) is what diagnostic uses with no plan section. So I describe monitoring as "ReAct with a planned coverage prompt" — the *coverage* is planned (which metrics to check), but the *execution* is still ReAct (the model picks the next call, observes, picks again). Real plan-and-execute is two model calls — a planner and an executor — with the plan as data between them. I don't have that. If I called the prompt section a "plan," I'd risk a reader thinking there's a separate planner call to debug or budget for. There isn't. The honest version: monitoring sits at "plan in prompt"; diagnostic and recommendation sit at "pure ReAct"; nothing in this repo is plan-and-execute proper.

Diagram:
```
   What's "in" plan-and-execute        What this repo has
   ────────────────────────────         ──────────────────────
   separate planner LLM call            ── absent ──
   plan as runtime JSON                 ── absent ──
   executor loop walking the plan       ── absent ──
   re-plan trigger on divergence        ── absent ──
                                        ─────────────────────
                                        plan-section in a system
                                        prompt + ReAct loop
                                        = "ReAct with coverage prompt"
```

### One-line anchors
- "Plan-and-execute earns its overhead only when the path is knowable AND the executor can stay cheap — neither holds for diagnostic or recommendation in this repo."
- "Monitoring's plan lives in the prompt at `monitoring.md` L39–L47, not in a runtime planner call — same shape on every workspace."
- "Every runtime plan-and-execute system eventually adds a re-plan trigger; that's the moment to ask whether ReAct would have been cheaper from the start."
- "The cheapest place for a plan is the prompt; the second cheapest is your code; the most expensive is a runtime call you make twice."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three positions from memory: pure ReAct (the diagnostic/recommendation/query shape), plan-in-prompt (the monitoring shape), and full plan-and-execute (the shape this repo does NOT use). Label which agents sit on which position and what each row adds in model calls per run.

Open the file. Compare.

✓ Pass: you have three positions, you put monitoring on plan-in-prompt and the other three on ReAct, and you correctly say plan-and-execute adds an expensive planner call up front
✗ Fail: re-read Move 2.4 and the primary diagram, wait 10 minutes, try again

### Level 2 — Explain it out loud
Explain "do you use plan-and-execute" to a colleague who just asked. No notes. Under 90 seconds.

Checkpoints — did you:
- Answer honestly that no agent has a separate planner call?
- Name the closest analog (monitoring's `## Suggested query plan` section at `lib/agents/prompts/monitoring.md` L39–L47)?
- Say why diagnostic and recommendation are NOT good candidates (each step depends on prior data)?
- Name the breakpoint where a runtime planner would start to earn its keep (per-workspace divergence)?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Can we let users pick which metrics matter to them and have the monitoring agent only check those?" Without looking at the file: would that change push monitoring toward runtime plan-and-execute, or is there a cheaper answer? What exactly would you touch in `monitoring.md` or in `monitoring.ts`?

Write your answer (3–5 sentences). Then open `lib/agents/prompts/monitoring.md` L39–L47 and `lib/agents/monitoring.ts` L83–L86 and check whether the user-picked metric list can be injected as a prompt variable (like `{categories}` is now, L11–L12 of the prompt), or whether the divergence is big enough that a runtime planner is cheaper.

### Level 4 — Defend the decision you'd change
"If you were starting today and expected user-customizable monitoring (per-workspace KPI lists, custom anomaly categories), would you still put the plan in the prompt, or would you start with a runtime planner? Why? If you'd switch, what new file would exist in `lib/agents/` and what would it return?"

Reference the code: point to `lib/agents/prompts/monitoring.md` L39–L47 for what exists today, and describe what a `lib/agents/planner.ts` would output as JSON the executor consumes.

### Quick check — code reference test
Without opening any files:
- Where in the codebase is the closest analog to a "plan" — what file and roughly what section?
- How many model calls does the monitoring agent's `scan()` make per turn? (One per turn — the plan is in the prompt, not a separate call.)
- Which of the four agents would be the worst candidate for plan-and-execute, and why?

Open and verify. ✓ File + section name + the "one model call per turn" answer matter; line numbers drifting is fine.

## See also

→ 02-react.md · → 04-reflexion-self-critique.md · → 06-routing.md · → agents-vs-chains: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` · → tool routing: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edit to Move 1 (named the codebase position — no runtime plan phase; closest cousin is the static "Suggested query plan" section in monitoring's prompt — alongside the strategy line, instead of waiting until Move 2.4).
