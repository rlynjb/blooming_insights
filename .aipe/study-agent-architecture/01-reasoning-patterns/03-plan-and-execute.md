# Plan-and-execute

**Industry name(s):** Plan-and-execute, plan-then-solve, decomposition-then-execution, multi-step planner
**Type:** Industry standard · Language-agnostic

> Separate the planning model from the execution model — one expensive call decides the route, many cheap calls walk it. blooming insights does NOT use this pattern as a runtime *phase*; the monitoring prompt bakes a static "suggested query plan" into the system prompt, which is a degenerate plan-in-prompt, not plan-and-execute proper.

**See also:** → 02-react.md · → 04-reflexion-self-critique.md · → 06-routing.md · → agents-vs-chains: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` · → tool routing: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`

---

## Why care

You've built a multi-step form before. The flow is: ask for an email, then a name, then plan, then payment, then confirm. The order is written *once* in your form's wizard component — `if (step === 1) … else if (step === 2) …` — and every user walks the same five steps. The user never decides the order. The wizard fills in *values*; it never invents step 3.5 or skips step 2 mid-session.

Now picture a different shape. Same five steps, but each step decides *whether the next step should run, and which one* — based on what the user just typed. Premium tier? Skip plan, jump to billing. Self-serve? Skip payment. You wrote a wizard whose route changes per session. That's already a step past a static form, and you can feel the cost: more branches to test, harder to debug a stuck user, every step's logic now depends on the whole prior state.

Now push it one more step. The wizard isn't five steps at all — it's "ask a model to list the steps for *this user* up front, then walk them." The model returns `[step1, step2, step5]` for one user and `[step1, step3, step4, step5]` for another, and your runtime just executes the list. That's the question this file answers: **when does separating the planner from the executor earn its overhead, and when is a single ReAct loop with a tight prompt enough?**

**Why answering that question matters:** because plan-and-execute looks like rigor and often is just overhead. Adding a "plan first" model call doubles your latency for every run and adds a brittleness — the plan is built from what the model *knows now*, not what it'll *find* mid-execution. If the data surprises the executor, the plan goes stale and the system has to choose between re-planning (expensive) and forging ahead on a wrong plan (wrong). The breakpoint is precise: is the path knowable up front, or does it depend on what the work uncovers?

Without naming the breakpoint:
- You add a planner because "good systems plan"
- Every investigation now pays one expensive call to produce a plan you could have written in the prompt
- The first time the data is sparse, the plan says "compare 90d vs prior 90d" and the executor faithfully returns ±100% on an empty window
- You add a re-plan trigger, then a re-plan budget, then a plan critic — drift

With the breakpoint named:
- Ask: is the path knowable? In monitoring, *yes* — the prompt's "Suggested query plan" lists exactly the 5 EQL queries that work
- That plan went into a prompt, not a phase — no extra model call
- The runtime stays a single ReAct loop that the model can adapt within (e.g. shift the time window when query #1 returns zero)

One-line summary: **plan-and-execute is moving the wizard's `if`-ladder from a code file into a "list the steps" model call — earn it only when the steps depend on per-run inputs that a static prompt can't enumerate.** blooming insights does not earn it; here's why.

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

The strategy in plain English: **decide once, execute many.** ReAct decides on every turn (which is why it scales token cost with depth). Plan-and-execute concentrates the decision-making in one call, then runs a much cheaper executor through the steps. The tradeoff is whether the plan survives contact with the data.

### Move 2.1 — The plan phase

The technical thing: a single LLM call whose output is structured — a list of step objects, each naming a tool and its inputs, possibly with dependencies between steps. Output schema is strict (JSON schema or a known shape), because the executor parses it as data.

If you're coming from frontend, this is the difference between writing `if (step === 1) handleEmail()` and writing `const steps = ['email', 'name', 'pay']; for (const s of steps) handle(s)`. The plan IS the array. Whoever writes the array — your code (static), or a model (dynamic) — owns the route.

```
Plan call output (the shape, not the impl)

  POST /messages { model: "expensive", system: PLANNER_PROMPT,
                   user: TASK }
  →  { plan: [
        { id: 1, tool: "execute_analytics_eql", args: {…},
          rationale: "establish baseline volume" },
        { id: 2, tool: "execute_analytics_eql", args: {…},
          depends_on: 1, rationale: "compare to prior window" },
        { id: 3, tool: "get_event_segmentation", args: {…},
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

Honest read: this codebase does *not* run a plan phase. There is no separate planner call. All four agents go straight into ReAct via `runAgentLoop` (`lib/agents/base.ts` L48–L176). Pre-execution, the only thing that happens is intent classification on `?q=` (a 16-token Haiku call in `lib/agents/intent.ts` L17–L31 that picks an agent — that's *routing*, not planning).

But there's a *degenerate* plan-in-prompt to name: the monitoring agent's system prompt at `lib/agents/prompts/monitoring.md` L39–L47 contains a literal section called **"## Suggested query plan (~5 calls, global)"** listing the five EQL queries the agent should run, in order. That's a plan — written by the engineer, baked into the prompt, the same for every run. The model then executes it inside a normal ReAct loop bounded by `maxToolCalls: 6`.

```
Plan-and-execute proper          What monitoring.md actually does
─────────────────────            ─────────────────────────────────
runtime plan call                static plan in the prompt
plan is task-specific             plan is identical across all runs
re-plan on failure               no re-plan — the loop just adapts
2 model calls (plan + execute)   1 model call (loop only)
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
                                  │ runAgentLoop     │ ◄── one model
                                  │ executes the plan│
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
  │  user prompt ──► runAgentLoop (model decides every turn)      │
  │                  per-turn cost grows with depth               │
  └──────────────────────────────────────────────────────────────┘

  POSITION B: plan in the prompt (what monitoring does)
  ┌──────────────────────────────────────────────────────────────┐
  │  user prompt ──► runAgentLoop                                 │
  │                  │ system prompt CONTAINS the plan            │
  │                  │ (monitoring.md L39–L47, 5-step list)       │
  │                  │ model walks it (mostly) — one model call    │
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

## In this codebase

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

## Tradeoffs

The decision here was *to put the monitoring plan in the prompt and run all four agents as pure ReAct*, rather than building a runtime planner. The alternative most teams reach for is "plan-and-execute for every multi-step task."

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Plan in prompt + ReAct       │ Runtime plan-and-execute    │
│                  │ (chosen)                    │ (alternative)               │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Per-run cost     │ 1 model call per agent +     │ 1 planner + N executor      │
│                  │ tool calls                   │ calls per agent             │
│ Latency          │ ~6–10s/agent under MCP rate  │ +planner latency (~1–3s)    │
│                  │ limit                        │ before any tool fires        │
│ Build time       │ author one prompt section    │ author planner prompt,      │
│                  │ + ReAct loop                 │ executor prompt, plan schema│
│                  │                              │ validator, re-plan trigger  │
│ Adaptability     │ model adapts WITHIN the plan │ planner sees task once;     │
│                  │ via observation              │ executor walks blindly      │
│ Per-run plan     │ none — same prompt always    │ tailored per task            │
│ tailoring        │                              │                             │
│ Debugging        │ replay 1 trace; one budget   │ replay plan + execution     │
│                  │ to reason about              │ separately; two surfaces    │
│ Failure mode     │ model deviates from prompt's │ plan goes stale mid-run →   │
│                  │ suggested order              │ wrong steps walked          │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up per-workspace plan tailoring for monitoring. Every workspace gets the same 5-query plan in the prompt, even ones where (say) the workspace has no `view_item` events — the agent runs the funnel query, gets zeros, and has to interpret that. A runtime planner would have read the workspace schema and skipped the funnel query for that workspace. The cost we accepted is one tool call wasted on a structurally empty query, in exchange for not running the planner ourselves.

We also gave up adaptive *step order* for monitoring. The prompt's plan says "volume first, then 180d window, then funnel, then traffic" — the agent mostly follows that, but it can't, say, escalate to a deeper investigation of one metric mid-scan because the loop has no concept of revising the plan. (For deeper investigation, the *whole* run becomes a diagnostic, handled by a different agent — that's the chain layer's job per `01-chains-vs-agents.md`.)

### What the alternative would have cost

If we had built a runtime planner for monitoring, every scan would pay an extra model call (1–3s, more tokens at the higher Opus pricing for the planner) just to produce a list the prompt already encodes. And every divergence — a workspace with sparse data, a missing event type, a category the user wants prioritized — would need either pre-planning enrichment (read the schema, decide what to include) or post-planning re-planning. Both add complexity that the static prompt avoids by simply being explicit about how to handle each case (the prompt's "CRITICAL: verify your windows actually contain data" at L31–L37 is the static answer to "what if the data is sparse").

The diagnostic agent's case is more pointed: a runtime planner would have written a plan like `[check time series, check segments, check campaigns]` — three perfectly reasonable steps that almost never survive the data. Real diagnostics need the second query to depend on what the first returned. ReAct's per-turn re-decision is exactly the shape that fits.

### The breakpoint

Plan-in-prompt stays the right call as long as the monitoring task's steps are stable across workspaces. The day workspaces diverge enough that the prompt can't enumerate their cases (e.g. multi-vertical workspaces where the right metrics differ by vertical, or workspaces where the user supplies custom KPIs the prompt can't know), the prompt's enumeration breaks and a runtime planner that reads the workspace + KPIs becomes the cheaper answer. Until then, the prompt is the planner.

### What wasn't actually a tradeoff

A "no plan at all, pure exploratory ReAct" was not a real alternative for monitoring. Without the suggested-query plan in the prompt, the agent burns its 6-call budget on metrics that don't matter (`select count event session_start by user_agent` or worse) and produces no actionable anomalies. The monitoring task's value is the *coverage* — it has to check each of (volume, revenue, conversion, traffic) — and only an enumerated plan reliably produces that coverage. So "no plan" isn't on the table; the question is only where to put the plan (prompt vs runtime call).

---

## Tech reference (industry pairing)

### Prompt-embedded plan (static plan)

- **Codebase uses:** `lib/agents/prompts/monitoring.md` L39–L47 — a literal "Suggested query plan (~5 calls, global)" section listing the EQL queries the agent should run, baked into the system prompt the `MonitoringAgent` (`lib/agents/monitoring.ts` L83–L86) hands to `runAgentLoop`.
- **Why it's here:** monitoring's steps are stable across workspaces, so the cheapest place to put the plan is the prompt — zero extra model calls, full transparency in version control.
- **Leading today:** prompt-embedded plans — adoption-leading for tasks with stable structure, 2026.
- **Why it leads:** for any agent task where the path is knowable, the prompt is the cheapest and most debuggable place to encode it; you read the plan in the prompt instead of replaying a planner trajectory.
- **Runner-up:** runtime plan-and-execute via LangGraph / LangChain `PlanAndExecute` — earns its overhead when the plan must be per-task; this codebase doesn't need that yet.

### LangGraph (the runtime plan-and-execute runner this repo does NOT use)

- **Codebase uses:** N/A — not a dependency.
- **Why it's here as a reference:** LangGraph is the closest industry-standard runtime for plan-and-execute orchestration. Naming what we don't use is the discipline.
- **Leading today:** LangGraph — innovation-leading for multi-step orchestration, 2026.
- **Why it leads:** treats the agent loop as an explicit state graph (nodes = LLM calls or tool calls, edges = transitions, checkpointed state), which lets plan-then-execute, re-plan triggers, and human-in-the-loop pauses all be first-class.
- **Runner-up:** CrewAI / AutoGen — agent-team flavor with built-in planner-worker shapes; trades the graph's inspectability for higher-level abstractions.

---

## Summary

Plan-and-execute is the pattern where an expensive model writes the step list once and a cheaper model walks it — earning its overhead when the path is knowable up front and the per-step context can stay small. In this codebase, the diagnostic, recommendation, and query agents are pure ReAct (no plan phase), and the monitoring agent runs ReAct against a *static* plan baked into its system prompt at `lib/agents/prompts/monitoring.md` L39–L47 — a plan-in-prompt, not a plan-and-execute phase. The constraint that made this right is task shape: monitoring's steps are stable across workspaces, so the prompt is the cheapest place for the plan; diagnostic's steps depend on prior queries' data, so a static plan would go stale. The cost is per-workspace tailoring — every workspace gets the same monitoring plan even when it would benefit from a tailored one.

- No runtime planner call exists in this repo; closest analog is the prompt section at `monitoring.md` L39–L47.
- The trade collapses to "where does the plan live" — your code, your prompt, or a runtime call — and the cheapest place that still works is the right one.
- ReAct wins where each step's choice depends on the prior step's data (diagnostic, recommendation, query); plan-and-execute wins where the steps are knowable but the executor can stay cheap.
- The most common failure of runtime plan-and-execute is plan staleness — the plan was written before the data was seen, the data surprises, the plan goes wrong.
- Worth it as a runtime phase only when the per-run plan must differ in ways a prompt can't enumerate; until then, write the plan in the prompt.

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

---
Updated: 2026-05-29 — created
