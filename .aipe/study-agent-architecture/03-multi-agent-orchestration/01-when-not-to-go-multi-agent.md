# When NOT to go multi-agent

**Industry standard.** The single most important multi-agent decision is whether to be multi-agent at all. **This is the file the repo carries the strongest live answer to.**

## Zoom out, then zoom in

Sits at the topology-selection layer — the decision *before* you wire any agents together. The escalation gate is the load-bearing structure: build a single-agent baseline, measure it, escalate only when a specific decomposable failure is identified.

```
  Zoom out — where this decision lives

  ┌─ Topology decision ─────────────────────────────┐
  │  ★ Should this be multi-agent at all? ★         │ ← we are here
  │  (the decision before any wiring)                │
  └────────────────────────────┬────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼ no                                          ▼ yes
  stay single-agent;                            pick the specific
  fix the prompt / tools / retrieval             topology that
  / context engineering                          addresses the failure
                                                 (Section C files 02-08)
```

This repo's answer is "no" — the orchestration is deterministic code, not an LLM supervisor; each stage is one single-agent loop. The choice is deliberate and is the senior-grade move in this domain.

## Structure pass

Layers: single-agent baseline (ReAct loop) → measurement (success rate, tool-call accuracy, latency, cost) → failure identification (specific failure single-agent cannot fix) → decomposability test (is the failure genuinely splittable into specialties?) → escalation (only if both gates pass).

**Axis traced — "what does the multi-agent escalation BUY?":** roughly 2-5x coordination overhead and a much larger debugging surface (you now debug the conversation between agents, not just one agent's loop). What it buys is *measurable quality on the specific decomposable failure* — and only that. If the failure isn't decomposable into specialties, you've paid the tax for no win.

**Seam:** the "decomposable into specialties" gate. Above the gate, you're solving the right kind of problem for multi-agent. Below it, you're solving the wrong kind.

## How it works

### Move 1 — the mental model

You know the cost of splitting a monolith into microservices. The monolith is one deployment, one log stream, one debugging session. Microservices are N deployments, N log streams, the entire distributed-systems failure surface — but each service is smaller, owned by a team, and independently scalable. You don't split because microservices are trendy; you split because you've measured a specific bottleneck (deployment coupling, team velocity, scaling cost) that monoliths can't fix.

Multi-agent is the same call. Single-agent is the monolith. Multi-agent is the microservices split — N agents, N prompts, N tool allowlists, the full coordination failure surface. You don't escalate because multi-agent is trendy. You escalate because you've measured a specific failure (quality on tasks that need a verifier, latency from sequential reasoning that could parallelize, prompt size that's hitting context limits) that single-agent can't fix.

```
  The escalation gate — every step is "are you sure?"

  ┌─────────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline         │
  │ 2. Measure: success rate, tool-call accuracy,    │
  │    latency, cost                                 │
  │ 3. Identify the SPECIFIC failure single-agent    │
  │    cannot fix                                    │
  │ 4. Is that failure genuinely decomposable        │
  │    into independent specialties?                  │
  │       │                                            │
  │       ├─ no  → stay single-agent, fix the         │
  │       │        prompt / tools / retrieval         │
  │       └─ yes → escalate to the SPECIFIC           │
  │                topology that addresses it         │
  └─────────────────────────────────────────────────┘
```

The fourth step is the load-bearing one. "It would be cooler with multiple agents" is not a decomposable failure.

### Move 2 — step by step

#### How this repo passed the gate the right way

The pipeline (`monitoring → diagnose → recommend`) splits along *capability boundaries* — three different jobs at three different layers of analysis. From a distance it looks like multi-agent. It isn't, because:

1. **The boundaries are deterministic.** "Monitor before diagnose; diagnose before recommend" is a hard sequence, not a model decision. The orchestrator (`app/api/briefing/route.ts` + `app/api/agent/route.ts`) writes the order; no model picks it.
2. **The handoffs are typed.** `Anomaly → Diagnosis → Recommendation[]` are TypeScript interfaces (`lib/mcp/types.ts:83-130`). Each stage produces a typed output the next stage consumes. There's no shared blackboard, no coordination protocol, no merger.
3. **No agent ever talks to another agent.** Every cross-stage flow is `previousAgent.output → typed value → nextAgent.input`. The next stage doesn't even know there was a previous stage — it just gets the typed `Anomaly` it needs.

This is what "deterministic pipeline of single-agent loops" looks like in code. It's the *right* answer when the work splits cleanly along stages, the stage order is known, and each stage is its own bounded task. Multi-agent vocabulary (supervisor, worker, handoff, message passing) doesn't apply because there's no LLM doing the coordination.

#### What an LLM-supervisor version would have looked like

Compare the deterministic shape to what a supervisor-driven version would do:

```ts
// hypothetical — what this repo COULD have been (and isn't)
class SupervisorAgent {
  async investigate(anomaly: Anomaly): Promise<{ diagnosis: Diagnosis, recs: Recommendation[] }> {
    // SupervisorAgent runs runAgentLoop with tools that are
    // "run_diagnostic_agent" and "run_recommendation_agent"
    // The model decides which to call when.
    const result = await runAgentLoop({
      model, tools, system: SUPERVISOR_PROMPT, ...
    });
    // synthesizes diagnosis + recs from sub-agent outputs
    return parseSupervisor(result.finalText);
  }
}
```

The supervisor would be one more agent loop, calling sub-agents as tools. Every per-investigation pipeline step costs:

- One supervisor model call to decide "now run diagnostic" (~$0.01-0.02 in Sonnet tokens).
- The actual sub-agent run (~$0.05-0.10 for diagnostic).
- One supervisor call to read the output and decide "now run recommendation" (~$0.01-0.02).
- Another sub-agent run (~$0.05-0.10 for recommendation).
- One supervisor call to synthesize (~$0.01-0.02).
- Plus the supervisor's overhead context (the system prompt, the sub-agent tool definitions, the running conversation).

Net: roughly 50-100% extra cost for the same outcome. The deterministic orchestrator skips every supervisor call because the orchestration is deterministic — "always diagnose before recommend; pass the diagnosis through; don't need a model to decide that." The repo's choice saves the supervisor tax.

#### The failures the deterministic shell DOESN'T address

This is where the honest cost shows up. The deterministic shell can't handle:

1. **Conditional pipelines.** "If the diagnosis has low confidence, run additional discovery agents before recommending." Today that branching would be one more `if` in the route handler; a richer condition (multiple branches, each with their own agent sequence) would push toward a state machine (graph orchestration, file 07).
2. **Iterative refinement.** "If the recommendation set is empty, re-run the diagnostic with different hypotheses." Today that's not in the pipeline; adding it would push toward a feedback loop (which is one degenerate form of supervisor-worker — the route handler as a small loop instead of a straight line).
3. **User-driven re-ordering.** "Sometimes the user wants to recommend without diagnosing." Today the UI doesn't expose this; if it did, intent classification would have to dispatch the right sub-pipeline.

None of these are *decomposable into specialties*. They're conditional control flow, which can be expressed with code (if-statements, loops, state machines) or with a supervisor model. Code wins on cost when the conditions are enumerable; the supervisor wins when the conditions are too varied for `if`s.

The repo today is well below the threshold where the supervisor would earn its tax. If a future feature like "follow-up investigations across days" or "ad-hoc multi-anomaly synthesis" landed and the branching exploded, that would be the signal to escalate.

#### The two parts of the gate the repo actually exercises

The full gate is "build → measure → identify failure → test decomposability." This repo lives in steps 1-2:

- **Built a single-agent baseline:** every stage is a single-agent ReAct loop. The pipeline is just sequence, not coordination.
- **Measure:** 144 Vitest tests cover the agents' trajectories and outputs. Wall-clock phase logging (`/api/briefing` and `/api/agent` emit `phases` arrays in the request summary log line) measures latency per stage. Token usage logs (every model call emits `JSON.stringify({site, sessionId, usage})` in `aptkit-adapters.ts:57-61`) track cost.

Steps 3 (specific failure to escalate from) and 4 (decomposable into specialties) haven't fired yet. The measured failures so far are operational (rate-limit retries from Bloomreach, token revocation on the alpha server, occasional structured-output drift) — none of which multi-agent would fix.

### Move 3 — the principle

**Reach for multi-agent only when single-agent has measurably failed on a problem that genuinely splits into specialties.** Two gates, both required. "Multi-agent is more interesting" fails both gates. "This feels like it should be multi-agent" fails the second gate. "Single-agent works fine but I want to try multi-agent" fails both gates spectacularly — you'll pay the 2-5x tax for no improvement, and you'll spend the next month debugging coordination bugs single-agent didn't have.

The senior-grade interview answer is: "I considered multi-agent and chose not to, because [the failure I'd be escalating from wasn't decomposable]." That's a stronger signal than "I built multi-agent first" — it shows you measured before you committed to a coordination tax.

## Primary diagram

```
  The escalation gate, applied to this repo

  ┌─ STEP 1: Build single-agent baseline ────────────────────────┐
  │   Done. Every stage is one ReAct loop.                        │
  │   MonitoringAgent, DiagnosticAgent, RecommendationAgent,      │
  │   QueryAgent — each runs runAgentLoop with bounded budget.    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
  ┌─ STEP 2: Measure ─────────────────────────────────────────────┐
  │   Done. 144 Vitest tests cover trajectories.                  │
  │   Wall-clock phase logs in /api/briefing and /api/agent.      │
  │   Token usage logs from the model adapter.                    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
  ┌─ STEP 3: Identify specific failure single-agent can't fix ───┐
  │   Open. The measured failures are operational                 │
  │   (rate-limits, token revocation, output drift). None are     │
  │   "the single agent reasons badly because the task needs      │
  │   specialty coordination."                                    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
  ┌─ STEP 4: Decomposable into specialties? ──────────────────────┐
  │   Not yet applicable — step 3 hasn't fired.                   │
  │                                                                │
  │   If a future failure pointed at "this needs a critic to       │
  │   catch wrong diagnoses": yes, decomposable; escalate to      │
  │   verifier-critic (file 05).                                  │
  │                                                                │
  │   If pointed at "this needs to fan out queries in parallel    │
  │   to hit latency budget": yes, decomposable; escalate to      │
  │   parallel/fan-out (file 04).                                 │
  │                                                                │
  │   If pointed at "the pipeline needs conditional branching":   │
  │   not decomposable into agents; escalate to graph             │
  │   orchestration (file 07) — same single agents, more wiring.  │
  └───────────────────────────────────────────────────────────────┘

  Current state: stay single-agent. The deterministic shell does
  the orchestration; each stage runs one ReAct loop; cost is
  ~50-100% lower than an LLM-supervised version would be.
```

## Elaborate

The 2-5x coordination tax claim from the spec is grounded in observed multi-agent deployments. The Anthropic "Multi-Agent Research" blog post (2025) documents the cost of their Research-Assistant system: a supervisor + 3-4 sub-agents costs roughly 4x the tokens of an equivalent single-agent ReAct system for the same research question, because every coordination message costs tokens on both sides and every sub-agent carries its own system prompt + tool definitions in its context. They argue the tax is worth it for *their* problem (deep research across many sources with synthesis) — and they explicitly call out that for simpler tasks the supervisor is overhead.

The "single most important multi-agent decision is whether to be multi-agent at all" line carries weight because the failure mode of premature multi-agent is invisible until you ship it. You don't see the wasted coordination tokens — they go straight to the bill. You don't see the debugging cost — it shows up the first time you have to figure out why agent B sometimes ignores agent A's output. The cost is real but lagging; the temptation to escalate early is real and immediate.

The deterministic-shell pattern this repo uses isn't a multi-agent system. It's the *correct alternative* for problems whose orchestration is knowable. The pattern reappears in production agent systems across companies under different names ("workflow orchestration with LLM nodes," "agent-as-a-step pipeline," "structured agentic workflow"). The vocabulary varies; the shape is consistent: deterministic outer code wrapping per-stage agents, with typed handoffs between stages.

## Interview defense

> **Q: Why isn't this codebase multi-agent? It has four agents.**
>
> It has four single-agent loops dispatched by deterministic code. Multi-agent means LLM-driven coordination — a supervisor that picks which agent runs, a debate where agents argue, a handoff where agent A transfers control to agent B at the model's discretion. This repo has none of that. The route handlers in `app/api/briefing/route.ts` and `app/api/agent/route.ts` write the orchestration in plain TypeScript: schema bootstrap, then monitoring, then (per user click) diagnose, then recommend. Each stage is a single agent with a bounded ReAct loop. The handoffs are typed values (`Anomaly → Diagnosis → Recommendation[]`), not LLM coordination messages. This is the "workflow with agent steps" shape, not multi-agent.

> **Q: When would you escalate to multi-agent?**
>
> When I'd identified a specific failure mode in the single-agent system that I could trace to a missing specialty AND the failure was important enough to justify roughly 2-5x coordination overhead. Concrete examples: if diagnoses started shipping confident-but-wrong conclusions, I'd add a verifier-critic with a different model family for the critic (file 05). If a single investigation needed to query 12 independent dimensions and the sequential latency exceeded our 300s budget, I'd add a fan-out pattern (file 04). If the pipeline grew conditional branches that the route handler's `if`s couldn't express cleanly, I'd add a graph orchestration layer (file 07) — same single agents, just an explicit state machine wrapping them. None of those failures are firing today, so I'm staying single-agent.

> **Q: What's the cost of escalating prematurely?**
>
> Two costs. Direct cost: every coordination message between agents costs tokens on both sides. A supervisor reading a sub-agent's output, deciding the next step, and dispatching to another sub-agent is at least 3 extra model calls per stage compared to "the route handler dispatches deterministically." For a 3-stage pipeline that's 9+ extra calls per investigation. The Anthropic multi-agent research post documents roughly 4x token cost for supervisor-driven research vs single-agent equivalents. Indirect cost: the debugging surface explodes. Instead of one agent's trajectory to inspect, you have N trajectories plus the coordination conversation between them. The trace plumbing (`CapabilityTraceSink → AgentEvent NDJSON → StatusLog`) has to span all of that; the eval surface has to verify coordination, not just per-agent behavior. For a problem the single-agent answer can handle, you pay both costs for no quality gain.

> **Q: How would you know if it was time to escalate?**
>
> Watch the eval set. If a specific failure shape recurs that I can articulate as "this would have been caught by a critic / handled by parallelism / structured by a state machine," that's the signal. If the failures are operational (rate limits, schema drift, tool errors), that's not a multi-agent signal — those are infrastructure fixes. The interview-grade move is to keep the failure-mode taxonomy explicit: what's failing, why, and is that failure decomposable into specialties? Three "yes" answers in a row from the eval set is when I escalate.

## See also

- → `02-supervisor-worker.md` — the most common escalation if the gate opens
- → `03-sequential-pipeline.md` — the structural alternative to multi-agent for known-order work
- → `09-coordination-failure-modes.md` — the failures that don't exist if you don't escalate
- → `06-orchestration-system-design-templates/` — all three templates name the refactor toward multi-agent that this repo could take
