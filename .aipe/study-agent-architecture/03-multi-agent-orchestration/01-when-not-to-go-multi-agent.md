# When NOT to go multi-agent (the escalation gate)

**Industry name(s):** Escalation gate, single-agent baseline, deterministic-orchestration-first, "do not auto-route what you can hand-route"
**Type:** Industry standard · Language-agnostic

> The architectural-opinion file: blooming insights IS multi-agent but deliberately MINIMAL — a deterministic pipeline + a router + single-purpose agents — and AVOIDS an autonomous LLM supervisor and its 2–5x coordination tax. The escalation gate names when the next step earns its overhead.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The "when not to go multi-agent" question sits at the Pipeline coordinator band — the place where blooming insights decided to use a deterministic `if`-ladder instead of promoting orchestration to an LLM supervisor. It's a *decision about the band itself*: keep the supervisor as code (`lib/agents/pipeline.ts`) or promote it to a model. blooming insights chose code, and this file is the gate that justified it. The Per-agent definitions and Shared agent loop below are unchanged either way — only the Pipeline band's owner moves between "engineer" and "model."

```
  Zoom out — where the "do we go multi-agent?" gate lives

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Pipeline coordinator ──▼────────────────────────┐  ← we are here
  │  ★ THE GATE ★                                     │
  │  Today (CODE owns coordination):                  │
  │    lib/agents/pipeline.ts — sequential, fixed     │
  │    order: monitoring → diagnostic → recommendation│
  │  Alternative (MODEL owns coordination):           │
  │    a supervisor agent reasons each next stage     │
  │    +1 LLM call per stage, ~2–5x cost tax          │
  └─────────────────────────┬────────────────────────┘
                            │  (same below either way)
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring | diagnostic | recommendation | query │
  └─────────────────────────┬────────────────────────┘
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop (lib/agents/loop.ts)               │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you *not* promote the parent `if`-ladder to an LLM supervisor — and when do you? It's not "do you have multiple agents" (blooming insights has four). It's "does control flow between them live in code or in a model?" The escalation gate is the test that decides; blooming insights walked through it once and chose code. Below, you'll see the gate's criteria and how this codebase passes them.

---

## Structure pass

**Layers.** This file is a *decision about the Pipeline coordinator band*, so the layers it weighs are the three bands the decision spans: the **Pipeline coordinator** (today: `lib/agents/pipeline.ts`, an engineer-written sequential `if`-ladder; alternative: an LLM supervisor agent that reasons about the next stage), the **Per-agent definitions** (monitoring, diagnostic, recommendation, query — these stay the same either way), and the **Shared agent loop** (`runAgentLoop` — also unchanged either way). Only the top band's owner is at stake.

**Axis: control.** Who decides the order in which the four agents run — engineer-written code or a model? This is the right axis because the entire gate is asking *should I move control of the inter-agent step from CODE to MODEL?* — and that's a yes/no on a single seam. Cost is a real concern (the supervisor variant costs +1 LLM call per stage, roughly a 2–5x coordination tax) but cost is the *consequence* of the control choice. State doesn't flip across the gate (every variant passes the same data shapes). Control is what the gate tests.

**Seams.** One seam is load-bearing: the seam between the Pipeline coordinator and the per-agent loops. Today control sits in CODE on the Pipeline side (the `if`-ladder fixes the order, no model is consulted about it) and flips to MODEL inside each per-agent loop (the agent decides its tool calls). Promoting to a supervisor would move the Pipeline side itself to MODEL — the flip would happen one boundary earlier, and the supervisor would re-decide what code already knew. The gate is the test for whether that move pays for itself.

```
  Structure pass — When NOT to go multi-agent (the gate)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Pipeline coordinator (CODE today / MODEL?)    │
  │  Per-agent definitions (unchanged either way)  │
  │  Shared agent loop (unchanged either way)      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides which agent runs next?   │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam: Pipeline coord ↔ per-agent loops        │
  │        (CODE → MODEL today)                    │
  │        ★ load-bearing — the gate is asking     │
  │        "should this seam move one band up?"    │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  The seam — "who decides the next stage?" answered two ways

  ┌─ Today (chosen) ─┐   gate    ┌─ Supervisor (alt) ┐
  │ CODE: if-ladder, │ ═══╪═════►│ MODEL: supervisor │
  │ fixed order,     │ (would    │ reasons each next │
  │ 0 extra LLM/run  │  flip)    │ stage, +1 LLM/run │
  └──────────────────┘           └───────────────────┘
         ▲                                     ▲
         └───── same axis (control), two answers ─┘
                → the gate decides if the flip earns it
```

The skeleton is mapped — the rest of this file walks the gate's criteria and how blooming insights passes them.

---

## How it works

**The mental model: a one-way gate you cross once you've earned it.** Single-agent on one side, multi-agent on the other. You don't walk through it because you read a blog post; you walk through it because the single-agent baseline measurably failed in a way only decomposition can fix.

```
The escalation gate

  ┌────────────────────────────┐
  │ 1. single-agent (ReAct)    │  start here, always
  │    baseline                │
  └─────────────┬──────────────┘
                ▼
  ┌────────────────────────────┐
  │ 2. measure                 │  success rate, tool-call accuracy,
  │    (real workload)         │  latency, cost, failure mode
  └─────────────┬──────────────┘
                ▼
  ┌────────────────────────────┐
  │ 3. is the failure          │
  │    decomposable into       │
  │    independent specialties? │
  └─────────────┬──────────────┘
        no ◄────┤────► yes
        │              │
        ▼              ▼
   stay single   pick the SPECIFIC topology
   agent —       that addresses the failure
   fix prompt,   (not "multi-agent" as a vibe)
   tools,
   retrieval
```

The strategy in plain English: **don't auto-route what you can hand-route.** Code is cheaper, more predictable, and easier to debug than a model. Promote control flow to a model only where the path genuinely depends on runtime data.

### Layer 1 — the single-agent baseline

The technical thing: a *ReAct loop* (reason → act → observe → repeat) inside one process, one prompt, one tool budget. The whole problem in one agent.

If you're coming from frontend, this is the parent component owning all state — every transition is a `setState` you wrote, every branch is an `if` you can grep for. You'd never reach for state machines, Redux, or XState until you'd felt the pain a `setState` ladder couldn't carry. Same instinct here.

```
single-agent baseline

  user → [ one agent ] → answer
              │
              ▼
       reason → tool → observe → reason → … → final

  one prompt, one tool budget, one trajectory
  one thing to debug
```

The practical consequence: every failure is in one place. You replay one trajectory. You tune one prompt. You don't pay for coordination because there isn't any. The catch is that one prompt has to cover the whole task — and if the task has genuinely distinct sub-jobs with different tool needs, the prompt gets long, the tool budget gets contested, and the model starts mixing concerns.

The condition under which it works: the task fits in one budget and one prompt without bleeding responsibilities. If it does, you're done — most "agentic" projects could stop here.

### Layer 2 — measure before you decompose

The technical thing: a *trajectory eval* — record real runs of the baseline, label the failures by type, and identify the failure mode the single-agent shape *can't* fix with more prompt tuning.

If you're coming from frontend, this is profiling before optimizing. You don't `useMemo` everything; you profile, find the one component that re-renders 200 times, fix that. Same here — you don't decompose by reflex, you decompose by evidence.

```
measure ⇒ classify failures ⇒ pick the fix layer

  failure type           fix layer
  ─────────────────      ──────────────────────────
  wrong tool chosen      prompt + tool descriptions
  tool succeeded but     prompt (output format) +
   output not used        retrieval (better context)
  budget blown on a      iteration cap + summary
   sub-task               step
  sub-tasks contend       ──► DECOMPOSE
   for the same budget
   AND have different
   tool needs
```

The practical consequence: if the failure is "the model picked the wrong tool," decomposing won't help — you have a prompt problem. If the failure is "the diagnostic sub-task starves the recommendation sub-task because they share a 12-tool budget," decomposing *does* help — that's a structural problem one prompt cannot fix.

The condition under which decomposition is the right answer: the failure is *structural*, not *propositional*. Structural = one loop physically cannot do the job (budget contention, tool subset conflict, prompt length). Propositional = the prompt told the model the wrong thing.

### Layer 3 — pick the SPECIFIC topology, not "multi-agent" as a vibe

The technical thing: once you've earned decomposition, you pick the topology that addresses the *specific* failure, not the most-blogged-about one.

If you're coming from frontend, this is choosing the state-management library by the problem it solves, not by which one HN voted for last week. Forms? React Hook Form. Cross-cutting cache? React Query. Don't import all three because "state management is good."

```
decomposable failure         topology that addresses it
──────────────────────       ─────────────────────────
shared budget contention     sequential pipeline (each stage
                              gets its own budget; output of one
                              feeds the next)         → see 03

independent sub-questions    parallel fan-out (Promise.all over
in a known set                workers; latency = max, not sum)
                                                      → see 04

high-stakes output where     debate / verifier-critic (second
errors are expensive          model reviews the first)
                                                      → see 05

peer specialists where the   swarm / handoff (peer-to-peer,
ORDER must depend on what    model-decided control transfer)
the data shows                                        → see 06

needs human-in-the-loop      graph orchestration (explicit
pause/resume                  state machine, checkpointing)
                                                      → see 07

ORDER of stages is fixed     deterministic route + sequential
(the blooming insights case) pipeline (no LLM supervisor)
                                                      → see 03 + 02
```

The practical consequence: blooming insights' specific failure was "one prompt cannot carry detect + diagnose + recommend with three different tool subsets and three different output schemas, in one tool budget." The topology that addresses *that* is the sequential pipeline with per-stage tool subsets — not a supervisor agent that reasons about ordering, because the order was already known. So the code stays deterministic. The four agents earn their decomposition; the route stays code.

The condition under which "deterministic route + pipeline" is enough: the stage *order* is knowable up front AND the workers are single-purpose AND no peer handoff is needed. All three are true here.

### Phase A vs Phase B — what would force the gate to move

```
        Now (this codebase)              If quality forced it later
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│ deterministic route             │  │ LLM supervisor agent            │ ←
│  (if-ladder picks next stage)   │  │  (reasons about which stage     │
│   ▼                             │  │   should run next, run-to-run)  │
│ sequential pipeline:            │  │   ▼                             │
│  monitoring → diagnostic →      │  │ same four agents — but the      │
│  recommendation                 │  │  supervisor may skip/loop/      │
│   ▼                             │  │  reorder them                   │
│ each stage = a ReAct loop       │  │   ▼                             │
│  (model-driven WORK, code-      │  │ each stage = a ReAct loop       │
│   driven ORDER)                 │  │  (unchanged)                    │
└─────────────────────────────────┘  └─────────────────────────────────┘
  the inner loops are identical — only the OUTER control owner
  moves from code to model
```

*Now:* the order is fixed (`monitoring → diagnostic → recommendation`) and the route file enforces it. The cost is zero extra LLM calls for ordering; the constraint is "this only works because the order is genuinely fixed."

*If quality forced it:* the day a stage's *output* has to change which stage runs next — e.g. "if the diagnosis is inconclusive, route to a deep-dive specialist instead of recommendation" — the route's `if`-ladder can't express that without becoming a switchboard. At that point the supervisor agent earns its overhead. Until then, it doesn't.

This is what people mean by "use the simplest orchestration that fits." The gate isn't a permission to never go multi-agent — it's a discipline to *measure first*. blooming insights is multi-agent. It's just multi-agent in the deterministic way, because the failure that forced decomposition didn't also force LLM-decided routing.

The full picture is below.

---

## The escalation gate — diagram

```
The escalation gate — full picture

  ┌─ SINGLE-AGENT BASELINE (always start here) ─────────────────┐
  │                                                              │
  │   user task                                                  │
  │      │                                                       │
  │      ▼                                                       │
  │   ┌──────────────────────┐                                   │
  │   │ one ReAct agent      │  one prompt, one tool budget,     │
  │   │ (reason → act → obs) │  one trajectory                   │
  │   └──────────────────────┘                                   │
  │      │                                                       │
  │      ▼  PRODUCTION measurement                               │
  │   success rate / tool-call accuracy / latency / cost         │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ DIAGNOSIS GATE ─────────────────────────────────────────────┐
  │                                                              │
  │   what kind of failure is this?                              │
  │                                                              │
  │   ┌─ propositional ──┐    ┌─ structural ──────────────────┐  │
  │   │ wrong prompt /   │    │ budget contention / mixed     │  │
  │   │ wrong tool desc /│    │ tool subsets / responsibilities│  │
  │   │ wrong retrieval  │    │ bleeding into each other      │  │
  │   └────────┬─────────┘    └────────────┬──────────────────┘  │
  │            ▼                           ▼                     │
  │   fix at the prompt /          DECOMPOSE                     │
  │   tool / retrieval layer       (and pick the topology that   │
  │   (stay single-agent)          addresses the specific failure)│
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
  ┌─ MULTI-AGENT (pick by failure, not by vibe) ─────────────────┐
  │                                                              │
  │   blooming insights' answer: sequential pipeline +           │
  │   deterministic route (NO LLM supervisor)                    │
  │                                                              │
  │   monitoring  ──►  diagnostic  ──►  recommendation           │
  │      (ReAct)         (ReAct)            (ReAct)              │
  │                                                              │
  │   each stage: its own prompt, its own tool subset, its own   │
  │   budget cap, its own forced-synthesis turn                  │
  │                                                              │
  │   the route file (app/api/agent/route.ts) is the supervisor  │
  │   — written in code, not as an agent.                        │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

This is the boundary file for SECTION C. It does not have a single line range; it names a *decision* taken across the codebase. The artifacts are:

**The deterministic supervisor (route, not agent)**
**File:** `app/api/agent/route.ts`
**Function / class:** the `GET` stream `start()` body
**Line range:** L199–L249 — lead-agent select (L199–L200), query branch (L210–L218), diagnostic→recommendation (L224–L249).

This is the `if`-ladder that picks the next agent. No model is consulted. If you imagine the LLM-supervisor alternative, this is the file you'd replace.

**The single shared ReAct loop (all 4 agents call it)**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L48–L176 — loop (L85), natural stop on zero `tool_use` (L121), observation fed back (L171), forced-final turn on budget spent (L90).

Each stage gets its own per-agent tool subset (`lib/mcp/tools.ts`) and its own `maxToolCalls` cap (6/6/6/4). The decomposition is real; the orchestration on top of it is deterministic.

**The cheap-model classifier (haiku, not sonnet)**
**File:** `lib/agents/intent.ts`
**Function / class:** `classifyIntent()`
**Line range:** L14 — `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` (Sonnet 4.6 is everywhere else, base.ts L9).

This is the gate applied at the per-call level: classification doesn't need Sonnet-grade reasoning, so it gets Haiku. Same principle — don't pay for capability the job doesn't need.

```
shape (not full impl):

  // The "supervisor" is THIS — an if-ladder in code, not an agent
  const leadAgent: AgentName =
    q && !insightId      ? 'coordinator'    // query flow
    : step === 'recommend' ? 'recommendation'
                           : 'diagnostic';   // pipeline default

  // The pipeline order is fixed; the route hands diagnosis to recommendation
  const diagnosis = await diagAgent.investigate(inv, hooks);
  const recs     = await recAgent.propose(inv, diagnosis, hooks);
```

---

## Elaborate

### Where this pattern comes from

The gate got its current framing from Anthropic's 2024 "Building Effective Agents" essay, which insisted that "agentic" was being claimed by systems that were workflows in disguise — and that workflows were not a worse version of agents, they were a *better* fit for problems where the path was knowable. The same essay coined the now-standard escalation order: start with a single LLM call; if it fails, add tools; if it fails, add a workflow; only at the end, if the workflow fails, escalate to autonomous agents.

The "2–5x coordination tax" number is empirical, reported across multiple agent-framework write-ups in 2024–2025: a multi-agent supervisor + workers typically costs 2–5x the tokens of a well-tuned single agent, with most of the spend going to the supervisor re-explaining context to each worker and synthesizing their outputs.

### The deeper principle

**Don't auto-route what you can hand-route.** Control flow is a thing you can place. Code is the cheapest, most predictable, most debuggable place to put it. Models earn their cost only where the path genuinely depends on runtime data the engineer can't know up front.

```
   path knowable up front  ─► code owns control flow
                              (chain, route, state machine)
   path depends on data    ─► model owns control flow
                              (ReAct loop, LLM supervisor,
                               swarm handoff)
```

This is the same instinct as choosing static rendering over client-side rendering for marketing pages: don't pay for runtime computation when the answer is the same every time.

### Where this breaks down

The gate becomes wrong when the codebase grows a *family* of stage orderings that can't be expressed as an `if`-ladder without exploding combinatorially — at that point the route file becomes a switchboard, and an LLM supervisor's reasoning over the same decision is cheaper to maintain. Also when the system has to interact with peer specialists where the *next specialist* is genuinely unknowable (a triage system that may need any of 20 sub-specialists, picked by the data) — that's swarm territory, and a route file is the wrong shape for it.

### What to explore next
- `./02-supervisor-worker.md` → the topology this file says no to, and the honest nuance about the route being a "hard-coded supervisor"
- `./03-sequential-pipeline.md` → the topology this codebase says yes to
- `./09-coordination-failure-modes.md` → the failures the deterministic shape *prevents*, not just controls
- `../01-reasoning-patterns/01-chains-vs-agents.md` → the chain/agent boundary at the per-loop level
- `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` → the mechanics of the boundary at the per-call level

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "why didn't you make this multi-agent" or "why didn't you use [framework] for the orchestration," they're testing whether you can defend an absence — whether you chose the simpler shape deliberately, or didn't know the complex one existed. The strong signal is showing you considered the autonomous-supervisor path and named the specific reason you didn't take it. The weak signal is calling deterministic orchestration "less advanced" — it's not. It's a different point on the cost ledger that this problem doesn't need to leave.

### Likely questions

[mid] Q: Is blooming insights multi-agent?

A: Yes — four agents (monitoring, diagnostic, recommendation, query), each with its own prompt and tool subset, each running the shared `runAgentLoop` in `base.ts`. But the orchestration on top is deterministic: the route file `app/api/agent/route.ts` L199–L249 is an `if`-ladder that picks which agent runs next. There's no LLM supervisor. So it's multi-agent in workers, single-process in coordination.

Diagram:
```
  route.ts (CODE supervisor, not an agent)
   ┌─────────────────────────────────┐
   │ if q && !insightId → query      │
   │ else step==='recommend'         │
   │      → recommendation           │
   │ else                            │
   │      → diagnostic → recommend   │
   └────────────┬────────────────────┘
                ▼
      one of four AGENTS runs
       (each a ReAct loop)
```

[senior] Q: Why didn't you let an LLM supervisor decide which agent runs?

A: Because the order is knowable up front — you always detect before diagnosing, diagnose before recommending; there's no anomaly you'd recommend-before-you-diagnose. A supervisor would pay 1–3 extra seconds per investigation under our ~1 req/s MCP limit to be told something I already know, and add a third suspect when something comes back wrong (supervisor mis-routed? worker mis-executed? synthesis mis-merged?). I kept ordering in code and freedom inside the loops, where the path genuinely is unknowable. The day a stage's output has to change which stage runs next, I'd promote the route to a supervisor — but not before.

Diagram:
```
  Chosen: code orders        Alternative: model orders
  ──────────────────         ──────────────────────────
  if-ladder picks stage      supervisor reasons each time
  0 extra LLM calls          +1 LLM call / decision
  order can't drift          order can drift
  2 suspects to debug        3 suspects to debug
```

[arch] Q: At 10x the user volume, would you still keep the route as the supervisor?

A: Yes for ordering, but I'd add layers around it. The `if`-ladder is stateless and free — it scales fine. The pressure points are the per-stage tool budgets against the shared ~1 req/s MCP rate limit (10x concurrent investigations means 10x concurrent agent loops hitting the same MCP server), and the model spend per run. I'd add fan-out backpressure (a concurrency limiter on the agent layer, see `../05-production-serving/02-fan-out-backpressure.md`), cross-run caching of repeated EQL sub-steps (`../05-production-serving/01-cross-turn-caching.md`), and per-tool circuit breakers. None of those add an LLM supervisor — they're all serving-layer controls on top of the same deterministic orchestration.

Diagram:
```
  ┌ Route layer (if-ladder) ──── fine, stateless ─────────┐
  ┌ Agent layer (4 ReAct loops) ◄─ ADD: concurrency cap,  │
  │                                cross-run cache         │
  ┌ MCP layer (1 req/s) ◄────────── ADD: circuit breakers, │
  │                                  per-tool backoff       │
  └ Supervisor: NOT NEEDED — order is still knowable        │
```

### The question candidates always dodge

Q: If you were starting today and the latest agent framework (LangGraph / OpenAI Agents SDK / etc.) makes supervisor + handoffs trivial to ship, would you still pick a deterministic route?

A: Yes, for this problem. The cost of "trivial to ship" is the same coordination tax — fewer lines of my code, but the same model calls, the same latency under the MCP rate limit, the same three-suspect debugging surface. Frameworks make the *expression* of autonomous orchestration easier; they don't change the *cost* of running it. The reason to stay deterministic isn't that the framework is hard; it's that the problem doesn't need a model to reason about ordering. I'd reach for the framework's graph orchestration the day I needed checkpointing or human-in-the-loop pauses (covered in `./07-graph-orchestration.md`) — that's a real win the framework gives you that my route file doesn't. But "easier to write a supervisor" isn't a reason to write a supervisor.

Diagram:
```
What's easy           What's still expensive
────────────────      ──────────────────────────────
  framework code:     coordination cost on EVERY run:
   one decorator,      +1 LLM call per ordering decision
   a Graph class       +token spend (2–5x)
   def of nodes        +debug surface (3 suspects)
                       +latency under shared MCP limit

The framework is sugar over the same coordination
tax. The tax doesn't get cheaper because the syntax did.
```

### One-line anchors

- "It's multi-agent in workers and single-process in coordination — that's deliberate, not a half-measure."
- "I split into specialists but kept orchestration deterministic, because the coordination didn't need an LLM to decide it."
- "The route file is the supervisor — written in code, with zero extra latency and one less suspect to debug."
- "Single-agent baseline → measure → decompose only on structural failure → pick the SPECIFIC topology. I didn't reach for multi-agent because it sounded good; I reached for it because one prompt couldn't carry three tool subsets."
- "The day a stage's output has to change which stage runs next, the gate moves. Not before."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the escalation gate from memory: single-agent baseline → measure → diagnosis (propositional vs structural failure) → if structural, pick the specific topology. Label what blooming insights' specific answer is at the bottom (deterministic route + sequential pipeline + per-stage tool subsets).

Open the file. Compare.

✓ Pass: you drew the three boxes (baseline, measure, diagnosis), the propositional/structural split, and named "sequential pipeline + deterministic route" as the answer for this codebase
✗ Fail: re-read How it works, wait 10 minutes, try again. Do not move on until you pass.

### Level 2 — Explain it out loud

Explain "why isn't this autonomously coordinated?" to a colleague who asked "but you have four agents — isn't that multi-agent orchestration?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name `app/api/agent/route.ts` as the supervisor (and clarify: it's *code*, not an agent)?
- Say why the stage order is knowable (monitoring → diagnostic → recommendation is fixed)?
- Name the tradeoff in one sentence (no LLM reasoning over ordering → no extra LLM calls + 2 suspects, not 3)?
- Name the breakpoint (when a stage's output has to change which stage runs next)?

If you skipped any: you described the architecture, you didn't defend it.

### Level 3 — Apply it to a new scenario

A product manager proposes: "Add a second-opinion agent that double-checks the diagnostic agent's conclusion before recommendation runs. If it agrees, continue. If it disagrees, re-run diagnosis with a deeper budget."

Without looking at the file: does this change require an LLM supervisor? Why or why not? What would land in `route.ts` and what would land in the agents themselves? Reference `../05-debate-verifier-critic.md` if needed.

Write your answer (3–5 sentences). Then open `app/api/agent/route.ts` L224–L249 and check whether the change is expressible as more `if`s, or whether it forces the route to *reason*.

### Level 4 — Defend the decision you'd change

"If you were starting this project today, with the same problem (anomaly detect → diagnose → recommend) but with 10x the anomaly types (now 100 categories instead of ~10), would you still keep the route as a deterministic `if`-ladder, or would you reach for an LLM supervisor? Why? If you'd switch, what would the supervisor cost you per investigation, and which lines in `route.ts` would it replace?"

Reference the code: `route.ts` L199–L200 (lead-agent select), L224–L249 (pipeline). Reference the budget caps in `lib/agents/diagnostic.ts` L62, `recommendation.ts` L57, `monitoring.ts` L101.

### Quick check — code reference test

Without opening any files:
- What file holds the deterministic supervisor (the `if`-ladder that picks the next agent)?
- What function holds the single shared agent loop, and in what file?
- Which model does the intent classifier use, and which model do the agents use?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `./02-supervisor-worker.md` · → `./03-sequential-pipeline.md` · → `./09-coordination-failure-modes.md` · → `../01-reasoning-patterns/01-chains-vs-agents.md` · → systems view: `../../study-system-design/06-multi-agent-orchestration.md` · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
