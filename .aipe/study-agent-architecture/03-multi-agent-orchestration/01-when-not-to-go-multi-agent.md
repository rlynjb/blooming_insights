# When NOT to go multi-agent

*Industry name: the multi-agent decision gate — Industry standard.*

The single most important decision in this whole section. Most teams reach for multi-agent before single-agent has hit a ceiling. This repo chose *minimal multi-agent* and the choice is the load-bearing one — read this file before reading the topology files.

## Zoom out — where this decision lives

Before any agent is instantiated, at design time. It's not a runtime decision — it's the architecture choice that shapes everything else.

```
  The escalation gate — at design time, before any code

  ┌─ "I need an agent" ──────────────────────────────────────┐
  │                                                            │
  │  → start with ONE ReAct loop. Measure.                    │
  │                                                            │
  │  → identify the SPECIFIC failure single-agent cannot fix  │
  │     - is the task genuinely decomposable into specialties?│
  │     - is there a quality ceiling the prompt can't lift?    │
  │                                                            │
  │  → only then escalate to a SPECIFIC topology               │
  │     - and pick the cheapest one that addresses the failure │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what does multi-agent cost, and what does it buy?**

```
  The cost of crossing the gate

  ┌─ Cost (you pay this no matter what) ────────────────────┐
  │  ~2-5x coordination overhead (tokens spent on how       │
  │    agents talk to each other, not on the actual task)   │
  │  much larger debugging surface (you now debug the        │
  │    conversation between agents, not just one agent's loop)│
  │  per-agent context juggling (which agent sees what)      │
  └──────────────────────────────────────────────────────────┘

  ┌─ Buy (you only get this if the task genuinely splits) ──┐
  │  decomposed specialties (each agent has a narrower prompt│
  │    and a narrower tool grant — focused, faster)          │
  │  parallel work (if the subtasks are independent)         │
  │  isolated failure surface (one agent's bug doesn't taint │
  │    the others)                                            │
  └──────────────────────────────────────────────────────────┘
```

The buy column only delivers if the task decomposes naturally. If the task is "answer a question about ecommerce data," the decomposition is forced — and forced decomposition pays the cost without the buy.

## How it works

### Move 1 — the mental model

Microservices have the same gate. You don't split a monolith into 12 microservices because microservices are cool — you split it when service boundaries are load-bearing for team velocity, deploy independence, or scaling. Multi-agent is the same: you split into N agents when the agent boundaries are load-bearing for the *task*. Most of the time they aren't, and you've added a coordination tax for nothing.

```
  The escalation ladder — only step up when a SPECIFIC failure justifies it

  ┌─ Step 0: prompt + tools ──────────────────────┐
  │  if the failure can be fixed by a better       │
  │  prompt or a better tool grant, do that        │
  └───────────────┬────────────────────────────────┘
                  │ failure persists
                  ▼
  ┌─ Step 1: single-agent ReAct ──────────────────┐
  │  if a measurable failure mode remains and      │
  │  isn't fixable by prompt/tools, escalate       │
  └───────────────┬────────────────────────────────┘
                  │ failure persists
                  │ AND task genuinely decomposable
                  ▼
  ┌─ Step 2: multi-agent (pick the cheapest        │
  │           topology that addresses the failure) │
  │  sequential pipeline (if steps are linear)     │
  │  supervisor-worker (if work is decomposable)   │
  │  fan-out (if subtasks are independent)         │
  │  debate (if quality > cost on high-stakes ops) │
  └────────────────────────────────────────────────┘
```

### Move 2 — how this repo crossed the gate (or didn't)

This repo went *minimal* multi-agent: three agents in a sequential pipeline, with a fourth for free-form Q&A and a fifth for intent classification. The supervisor is `app/api/agent/route.ts` — TypeScript code, not an LLM.

The decision rationale:

```
  Why minimal multi-agent for blooming insights

  Question to answer:                Decision:
  ───────────────────                ─────────
  "Is the task decomposable          Yes — the product workflow IS
   into specialties?"                 three named steps (what changed
                                      → why → what to do). Each step
                                      has a different output shape,
                                      a different tool grant, a
                                      different cost profile.
                                      → split into three agents

  "Does the supervisor need          NO — the steps run in a fixed
   to decide which agent next?"       order. The URL `?step=` carries
                                      the decision. Burning an LLM
                                      call to re-derive "run the
                                      diagnostic agent next" is waste.
                                      → supervisor stays as code

  "Do the agents need to             NO — each agent's input is the
   share state across each other?"    previous agent's output, passed
                                      as a plain JSON arg. Vercel's
                                      ephemeral instances FORCE this
                                      anyway (no shared memory
                                      between requests).
                                      → message passing, no blackboard

  "Do subtasks fan out?"             NO — the monitoring agent runs
                                      categories sequentially; no
                                      worker agents. Bloomreach's
                                      ~1 req/s rate limit also
                                      forbids parallel calls.
                                      → no fan-out

  "Do we need a critic agent?"       NOT YET — the StatusLog UI shows
                                      every hypothesis + tool call;
                                      the user is the critic. Adding
                                      an LLM critic now would double-
                                      pay for the same check.
                                      → no debate / verifier-critic
```

The pattern: every "yes" added a piece of multi-agent infrastructure; every "no" stayed minimal. The result is the cheapest topology that still composes specialized agents — which is also the most debuggable.

### Move 3 — the principle

Multi-agent is microservices for LLM systems. The cost is real and compounds with the number of agents; the gain is conditional on the task genuinely splitting. The senior move is "I considered multi-agent and chose [this minimal version] because [the failure single-agent couldn't fix]." Not "I went multi-agent because that's the modern shape."

This repo's specific senior move: **the supervisor is code, not an LLM.** When the orchestration decision is "what does the URL say," you don't need an agent to decide; you need an `if` statement. Coordination cost: zero tokens, zero latency, zero debugging burden. Cost saved by NOT having an LLM supervisor: probably 30-40% of total tokens, plus the entire surface of "why did the supervisor pick the wrong agent" bugs.

## Primary diagram

The four shapes, ranked by overhead, with this repo's place marked:

```
  Multi-agent topologies — ranked by overhead

  ┌─ NONE: single-agent ReAct ──────────────────────────────┐ ★ where most teams should stop ★
  │  one loop, one model, one tool grant                     │
  │  cost: baseline                                          │
  └──────────────────────────────────────────────────────────┘

  ┌─ MINIMAL: sequential pipeline + code supervisor ────────┐ ★ ← BLOOMING INSIGHTS LIVES HERE ★
  │  N agents in a fixed order, dispatch by `if (step===X)` │
  │  cost: ~Nx single-agent (because N agent calls in series)│
  │  buy: specialization, isolated failure surface           │
  └──────────────────────────────────────────────────────────┘

  ┌─ MID: supervisor-worker (LLM supervisor) ───────────────┐
  │  supervisor LLM decides which worker, then synthesizes  │
  │  cost: ~2-3x single-agent                               │
  │  buy: dynamic dispatch (workers chosen per request)      │
  └──────────────────────────────────────────────────────────┘

  ┌─ HEAVY: fan-out + supervisor + debate ──────────────────┐
  │  parallel workers + critic agents + multi-round arguing  │
  │  cost: 5-10x single-agent                                │
  │  buy: only when quality > cost on high-stakes ops        │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The "2-5x coordination overhead" number isn't a guess — it's the rough consensus from teams who shipped multi-agent and went back to single-agent (or, like this repo, minimal multi-agent). The token overhead breaks down as:

- **Supervisor calls** to dispatch and synthesize — each is a full LLM turn over the running context
- **Per-worker context setup** — each worker needs the task description, sometimes the shared state, often the prior workers' outputs
- **Synthesis on the way out** — combining N workers' outputs into one answer is another full call

The debugging cost is harder to quantify but worse in practice. A single-agent loop has one trajectory you can read top-to-bottom. A 4-agent supervisor-worker has a tree of trajectories where the supervisor's decision logic lives in *prompts*, not code — so "why did it pick worker B" is a prompt-engineering question, not a stepping-through-code question. Production teams routinely report 3-5x debugging time vs single-agent.

The honest framing for when multi-agent earns its overhead: when one of these is true and *measurable*, not theorized:
- The single-agent loop's success rate plateaus and the failure mode is "the model can't hold context across roles" (split into specialized agents helps)
- The latency is dominated by sequential dependencies that aren't actually sequential (split into parallel agents helps)
- The output quality benefits from a different model's perspective (debate / critic helps)

If none of these are measured failures of single-agent in your system, you don't have justification for multi-agent yet. Build single-agent, measure, escalate on evidence.

## Interview defense

**Q: "Why is your system multi-agent?"**

A: It's *minimal* multi-agent — three agents in a sequential pipeline, plus a free-form QueryAgent and an intent classifier. The supervisor is route code, not an LLM. The decomposition is the product workflow: what changed (monitoring) → why (diagnostic) → what to do (recommendation). Each step has a different output shape, a different tool grant, a different cost profile — those are real specializations, not forced ones. What I deliberately *didn't* add: an LLM supervisor (the URL knows which agent runs; an LLM picking would be ~30-40% token waste), fan-out (Bloomreach's ~1 req/s rate limit makes parallel infeasible without a concurrency cap), debate (the StatusLog UI already shows every tool call to the user — they're the critic).

Diagram I'd sketch:

```
  ┌─ minimal multi-agent ─────────────────────┐
  │                                            │
  │  /api/briefing → MonitoringAgent (ReAct)  │
  │                       │                    │
  │  /api/agent?step=  →  DiagnosticAgent     │
  │   diagnose           (ReAct)               │
  │                       │ (diagnosis via URL)│
  │  /api/agent?step=  →  RecommendationAgent │
  │   recommend          (ReAct)               │
  │                                            │
  │  supervisor = `if (step === X)` in TS     │
  └────────────────────────────────────────────┘
```

Anchor: "the supervisor is code because the dispatch is deterministic. Burning an LLM call to decide 'which agent for the recommend URL' would be pure waste."

**Q: "What did you NOT do, and why?"**

A: Three big ones. No LLM supervisor (the orchestration is deterministic; an LLM would just re-derive what the URL already encodes). No fan-out (Bloomreach's rate limit forbids concurrent calls without a per-tool concurrency cap, which is its own refactor — see `../05-production-serving/02-fan-out-backpressure.md`). No debate / critic (the StatusLog streams every reasoning step and tool call to the user — the human is the critic; adding an LLM critic now would double-pay). Each "no" maps to a specific cost we're not paying yet. The senior-grade move is naming when we *would* cross each gate: critic when the product moves to autonomous-analyst mode with no human review; fan-out if the monitoring agent's 6-call sequential budget becomes the latency bottleneck; LLM supervisor when the workflow becomes too dynamic for a fixed URL routing table.

## See also

- [`03-sequential-pipeline.md`](./03-sequential-pipeline.md) — the topology this repo did pick
- [`02-supervisor-worker.md`](./02-supervisor-worker.md) — the next step up that this repo deliberately avoided
- [`09-coordination-failure-modes.md`](./09-coordination-failure-modes.md) — what crossing the gate exposes you to
- [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md) — the outer-shape decision that frames this one
