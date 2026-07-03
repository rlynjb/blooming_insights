# Swarm / handoff

_Industry standard._

## Zoom out, then zoom in

Peer-to-peer control transfer, no central boss. Agents decide among themselves when to hand control to a specialist. This codebase rejects the swarm pattern *by design* — the supervisor is deterministic TypeScript, not an LLM voting on the next agent. This file names why supervisor-worker beats swarm for this problem and where swarm would actually be the better fit.

```
  Zoom out — the shape blooming rejects

  ┌─ Swarm topology (NOT USED HERE) ─────────────────────────────┐
  │                                                              │
  │  ┌────────┐  "you take it"  ┌────────┐  "over to you"        │
  │  │agent A │ ──────────────► │agent B │ ──────────►  agent C  │
  │  └────────┘                 └────────┘                       │
  │       ▲                                                      │
  │       └──────── "back to A" ─────────────────────────────────┤
  │                                                              │
  │  No central log of who's running. No stateful supervisor.     │
  │  The handoff decision lives in each agent's prompt.           │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: this codebase's control flow is written in `app/api/agent/route.ts`. Every worker transition is a top-level `await`, visible in one file, debuggable with a stack trace. Swarm would move those transitions inside worker prompts. That trade would buy flexibility at the cost of observability, and this repo's product surface (a streaming reasoning trace) makes observability the load-bearing property.

## Structure pass

**Layers:** agent A (initial) · handoff decision · agent B (specialist) · optional handoff back.
**Axis:** *where does the "who runs next" decision live — code or prompt?*
**Seam:** the handoff instruction. In swarm, it's a tool call (`handoff_to("expert-agent")`) or a special output shape. In supervisor-worker, it's a code branch.

```
  Where the routing decision lives

  Swarm:                              Supervisor-worker (this repo):
  routing lives in prompts            routing lives in route.ts

  Agent A's prompt:                   route.ts:229-232:
  "If the question is about X,        if (q && !insightId) → coordinator
   hand off to Agent B by             else if (step === 'recommend')
   emitting handoff('B')"                 → recommendation
                                      else → diagnostic

  cost: an LLM decision per hop       cost: 0 model calls per hop
  observability: log the LLM output   observability: read the code
```

## How it works

### Move 1 — the mental model

You've written React components that render conditionally based on internal state — a wizard's step component decides which sub-component to render next. That's swarm's control model: the *component itself* decides what runs next. Supervisor-worker is the opposite: a parent component decides, children just execute. Same debug question, opposite answer.

```
  Pattern: swarm handoff

     ┌────────┐  handoff("data_expert")  ┌────────────┐
     │ Router │ ──────────────────────► │ DataExpert │
     └────────┘                          └──────┬─────┘
          ▲                                     │ handoff("summarizer")
          │                                     ▼
          │                              ┌───────────┐
          └──── handoff("router") ────── │ Summarizer│
                                         └───────────┘

  The model itself picks the next agent, mid-loop.
```

### Move 2 — the walkthrough

**Why blooming chose supervisor-worker over swarm.** Three concrete reasons, each measurable:

- **Observability.** The streaming reasoning trace (`components/investigation/ReasoningTrace.tsx`) is the product's differentiator — "an analyst that shows its work." Every worker transition needs to be a clean event in the NDJSON stream. In supervisor-worker, transitions are top-level `await`s that emit `type: 'diagnosis'` or `type: 'recommendation'` events. In swarm, transitions would be model outputs interpreted as handoffs, which are harder to render as discrete phases in the stepper.

- **Predictability.** The product has three UI phases (feed → investigate → recommend) that map 1:1 to three agents. The user's URL is the state (`/investigate/[id]/recommend`). Swarm's handoffs would decouple the topology from the URL — the model might decide to hand back and forth between diagnostic and recommendation, and the UI can't render that as a fixed three-step process.

- **Cost.** Every swarm handoff is a model decision — cost per hop. Blooming's route runs 3 hops per full investigation (classify → diagnose → recommend). Swarm would add ~3 additional Sonnet-turn costs to decide "should I hand off now?" at each stage. That's a ~30% latency and cost increase for zero product benefit.

**Where swarm WOULD be the right fit.** Consider a customer-support agent (`06-orchestration-system-design-templates/02-agentic-support-system.md`) where the initial classifier can't know upfront whether to route to billing, tech, or account. A billing specialist might realize partway through that this is actually a fraud case and hand off to fraud specialists. The handoff decision is *emergent* — no upfront supervisor can enumerate the paths. That's when swarm earns its overhead. Blooming's domain isn't like that: the phases are known and the sequence is fixed.

**The failure mode swarm introduces — infinite handoff.** A → B → A → B forever. Anthropic's "Building Effective Agents" (2024) names this specifically: swarms need a handoff counter or a hop budget, or they cycle indefinitely. `09-coordination-failure-modes.md` walks the mitigations. The counter has to persist across agent boundaries, which in a swarm topology means... a supervisor. That's the tension — the cure for swarm's biggest failure mode is exactly the thing swarm was designed to eliminate.

```
  Layers-and-hops — the observability gap swarm creates

  Supervisor-worker (this repo):        Swarm (rejected):
  ┌─ route.ts ──────────┐               ┌─ AgentA ────────────┐
  │  await AgentA()     │               │  loop, then output  │
  │  send('diagnosis')  │               │  "handoff('B')"     │
  │  await AgentB()     │               └────────┬────────────┘
  │  send('recommend')  │                        │
  └─────────────────────┘                        ▼
                                        ┌─ AgentB ────────────┐
                                        │  reads handoff, runs│
                                        │  loop, may hand back│
                                        └─────────────────────┘
                                          ↑
                                  Where does the UI render the transition?
                                  Where does the trace log which agent ran?
```

### Move 3 — the principle

Swarm is right when the routing decisions are emergent and cheap to be wrong about. Supervisor-worker is right when the routing is knowable upfront and observability matters. Blooming's product surface — streaming reasoning to a user watching phase-by-phase progress — makes observability the load-bearing property, so supervisor-worker wins by construction. The interview-grade version of this answer names the tradeoff (flexibility vs traceability) and lands the choice on the *product* consequence, not on preference.

## Primary diagram

```
  Recap — swarm vs supervisor-worker, and why this repo picked one

  Swarm (rejected):                    Supervisor-worker (this repo):
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │ agent decides next agent │        │ route.ts decides         │
  │ via handoff tool          │        │ via TypeScript branch    │
  │                           │        │                          │
  │ + flexible               │        │ + observable             │
  │ + emergent routes         │        │ + cheap                  │
  │ - hard to log             │        │ + debuggable             │
  │ - hop cost is per-model   │        │ - inflexible if routes   │
  │ - infinite handoff risk   │        │   change per request     │
  └──────────────────────────┘        └──────────────────────────┘

  Blooming picks supervisor-worker because the product surface
  (streaming trace, three-phase UI, URL-as-state) needs observability
  more than it needs runtime flexibility.
```

## Elaborate

Swarm as a formal topology was popularized by OpenAI's `swarm` reference implementation (2024) — a research demo showing minimal agent-to-agent handoffs. It's an elegant pattern for problems with *unpredictable routing* (customer support with unknown escalation paths, research agents that don't know what specialists to call until they've explored). It's the wrong pattern for problems with *predictable routing* (a fixed three-phase workflow).

Anthropic's "Building Effective Agents" (2024) is more skeptical: they explicitly recommend deterministic supervisor + task-specialist workers as the default, with swarm reserved for cases where the specialist set genuinely can't be enumerated. Blooming inherits that posture — the three phases are known, the specialists are known, no case for swarm.

The one place blooming has an LLM-driven routing decision is `classifyIntent` (see `01-reasoning-patterns/07-routing.md`). That's a *scoped* LLM route inside a deterministic supervisor: the LLM picks the intent, then the supervisor deterministically dispatches based on it. That's the "cascade" pattern Anthropic recommends — code where predictable, LLM at the specific sub-decision where flexibility matters.

## Interview defense

**Q: Why not swarm handoff for this system?**
A: Three reasons. Observability first — the product's differentiator is a streaming reasoning trace with a three-phase UI, and supervisor-worker makes each phase transition a clean event in the NDJSON stream. Swarm would push those transitions inside worker prompts, harder to render as discrete phases. Cost second — every swarm handoff is a model decision, adding ~30% latency and cost for a workflow whose routing is already known upfront. Predictability third — the three phases map 1:1 to URL routes, and swarm's flexible routing would decouple the topology from the URL, breaking the back/forward navigation model. Swarm would be the right choice for a customer-support agent where escalation paths are emergent; it's the wrong choice here because the sequence is fixed.

Diagram: the two topologies side-by-side, with a callout on observability as the load-bearing property.
Anchor: `app/api/agent/route.ts` (the deterministic supervisor) vs the hypothetical swarm.

**Q: What's the failure mode swarm introduces that supervisor-worker doesn't have?**
A: Infinite handoff — A → B → A → B forever. Swarms need a hop counter or a budget that persists across agent boundaries, and the natural place to put that counter is... a supervisor. Which is the thing swarm was designed to eliminate. That tension is the load-bearing critique: cure for swarm's biggest failure mode looks a lot like supervisor-worker. Supervisor-worker doesn't have this mode because the supervisor is the single control point — no cycles unless the supervisor writes them.

Diagram: the A→B→A→B cycle and the missing hop counter.
Anchor: `09-coordination-failure-modes.md` for the counter pattern.

## See also

- `02-supervisor-worker.md` — the shape this repo actually uses.
- `07-graph-orchestration.md` — the alternative for cases where the topology needs to be flexible AND observable.
- `09-coordination-failure-modes.md` — infinite handoff and its mitigation.
- `06-orchestration-system-design-templates/02-agentic-support-system.md` — where swarm would fit.
