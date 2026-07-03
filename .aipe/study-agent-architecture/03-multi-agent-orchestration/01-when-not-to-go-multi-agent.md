# When NOT to go multi-agent

_Industry standard._

## Zoom out, then zoom in

The single most important multi-agent decision is whether to be multi-agent at all. This file comes first in the sub-section by design. The default answer is *no* — stay single-agent — and this file names the specific conditions under which the answer flips.

```
  Zoom out — the gate before every multi-agent decision

  ┌─ Business need ────────────────────────────────────────────┐
  │  "We need the agent to do X"                               │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ Escalation gate ──────────────────────────────────────────┐
  │  1. Build a single-agent (ReAct) baseline                  │
  │  2. Measure: success rate, tool-call accuracy, latency, $ │
  │  3. Identify SPECIFIC failure single-agent cannot fix     │
  │  4. Is failure genuinely decomposable into specialties?    │
  │       ┌────────────────┴──────────────────┐                 │
  │       ▼ no                                 ▼ yes            │
  │  stay single-agent               escalate to SPECIFIC       │
  │  fix prompt / tools / retrieval  topology addressing it     │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this repo passed the gate. There are 5 agents. The senior-grade answer is naming *why* they're separate agents, not why "multi-agent is better."

## Structure pass

**Layers:** single-agent baseline · measurement · failure identification · decomposability check · topology selection.
**Axis:** *is the failure genuinely decomposable into specialties, or is it a single-agent that needs better prompting?*
**Seam:** the decomposability check. This is where most teams flip too early and pay 2-5x coordination tax for no quality lift.

```
  The coordination tax — what multi-agent costs

  Single-agent:                Multi-agent:
  1 model call per turn        N model calls per turn (per agent)
  1 context window             N contexts to route
  1 debugging surface          N agents + inter-agent messages
  Cost baseline                2-5x coordination overhead
  Latency baseline             adds handoff + synthesis time
```

## How it works

### Move 1 — the mental model

You've refactored a monolithic React component into smaller ones before. Sometimes it clarifies (each has one job); sometimes it fragments (now you're passing 12 props between them). Multi-agent has the same trap — decomposition helps when the pieces genuinely differ, and hurts when they don't. The senior move is naming the concrete quality gain and comparing it to the 2-5x cost, not decomposing for aesthetics.

```
  Pattern: the decomposability test

  Does the task split into pieces that:
    (a) need different tool sets?
    (b) need different context/prompts?
    (c) have measurably different failure modes?

  All three → multi-agent probably wins
  Two of three → maybe; measure
  One or none → single-agent with better prompt shaping
```

### Move 2 — the walkthrough

**Why blooming_insights passes the gate.** The three-agent-split (Monitoring, Diagnostic, Recommendation) meets all three criteria:

- **(a) Different tool sets.** Monitoring uses ~10 category-scan tools (EQL variants tuned for anomaly detection). Diagnostic uses the 11-tool investigation allowlist (evidence gathering). Recommendation uses a different subset (list_scenarios, list_experiments — action-shape tools). Different lists, no overlap in intent. See `node_modules/@aptkit/.../diagnostic-agent.js:8-23` for the diagnostic policy; the equivalent lists exist for monitoring and recommendation in the AptKit packages.

- **(b) Different context/prompts.** Monitoring's prompt is "scan for anomalies against these 10 categories." Diagnostic's is "given this anomaly, investigate the cause." Recommendation's is "given this diagnosis, propose Bloomreach actions." A single-agent prompt that covered all three would be huge, context-bloat prone, and would confuse the model about which mode it was in.

- **(c) Different failure modes.** Monitoring fails on schema-gate errors (which categories can run against this workspace?). Diagnostic fails on inconclusive evidence. Recommendation fails on inappropriate feature choice (recommending a Scenario when a Segment would fit better). Different failures, different fixes.

**What DOESN'T pass the gate — and would collapse back to single-agent.** Imagine splitting Diagnostic into "Hypothesizer" and "Evidence-Gatherer" agents. Both would use the same 11 tools, run against the same workspace context, and fail the same way (bad EQL syntax). The split would be aesthetic (nice separation!) and cost 2x — no measurable win. This split was considered and rejected during the AptKit migration.

**Coordinator/Query is a router, not a fourth worker.** `classifyIntent` picks between diagnostic-shaped and exploratory-shaped queries but doesn't have its own worker loop with tools — it hands off to `QueryAgent` after routing. Calling it a "coordinator agent" would inflate the count without earning it. See `01-reasoning-patterns/07-routing.md`.

**The cost, made concrete.** A single-agent "do everything" prompt would probably cost ~$0.05/investigation (one model, one prompt, one loop). The three-agent split runs at ~$0.09/investigation (diagnose ~$0.045 + recommend ~$0.045). The 80% cost premium buys: clean prompts, three UI phases, isolated failure handling, per-agent evaluation. In production I traded 80% cost for a system I can actually reason about and iterate on independently per agent.

### Move 3 — the principle

Multi-agent adds 2-5x coordination cost. That cost has to buy something concrete: different tools, different prompts, different failure modes, or all three. If it buys nothing but "cleaner architecture," you're building the wrong thing. The senior-grade answer to "why multi-agent" is not "we needed more agents" — it's "here's the specific decomposition the problem forced, and here's the measured quality lift over single-agent."

## Primary diagram

```
  Recap — the escalation gate applied to this repo

  Task: "notice, diagnose, recommend"
    │
    ▼
  Would single-agent work?
    │
    ▼
  Single-agent baseline attempted (legacy files: base-legacy.ts, etc.)
    │
    ▼
  Failure identified: prompt bloat + context confusion
  when one prompt covered notice+diagnose+recommend
    │
    ▼
  Decomposable? YES:
    - monitor: 10 category tools, "scan" prompt
    - diagnose: 11 evidence tools, "investigate" prompt
    - recommend: action-shape tools, "propose" prompt
  Different tools, different prompts, different failures.
    │
    ▼
  → Escalate to 3-agent supervisor-worker (chain-shape)
  → Cost: +80% per investigation (~$0.09 vs ~$0.05 baseline)
  → Buys: cleaner iteration, three UI phases, per-agent evals
```

## Elaborate

Anthropic's "Building Effective Agents" (2024) is the source for the "don't reach for multi-agent before single-agent hits its ceiling" rule. The specific failure the paper warns about: teams that adopt multi-agent for aesthetic reasons ("microservices for agents!") and end up debugging inter-agent conversations for weeks. The paper's recommended posture is exactly what this repo does — deterministic supervisor + task-specialist workers.

The historical shape here: legacy `lib/agents/base-legacy.ts` was a hand-written single-agent loop that tried to cover everything. Splitting it during the AptKit migration wasn't aesthetic — it was because the single prompt had grown to 400+ lines and the model was frequently confused about which phase it was in. The split fixed the confusion by narrowing each agent's job.

## Interview defense

**Q: Why is this a multi-agent system instead of a single-agent one?**
A: Three concrete reasons: different tool sets per phase (Monitoring's category-scan tools, Diagnostic's evidence-gathering allowlist, Recommendation's action-shape tools), different prompts (scan vs investigate vs propose), and different failure modes (schema-gate errors vs inconclusive evidence vs inappropriate feature). All three criteria — tools, prompts, failures — are genuinely distinct. Single-agent with one 400-line prompt was the previous shape and the model got confused about which mode it was in. The 3-agent split costs 80% more per investigation and buys cleaner iteration + per-agent evals.

Diagram: the three-criteria decomposability test.
Anchor: `node_modules/@aptkit/.../diagnostic-agent.js:8-23` (the tool policy split) + `lib/agents/base-legacy.ts` for the earlier monolithic shape.

**Q: When would you collapse back to single-agent?**
A: If the phases stopped being distinct — same tools, same context, same failures. In practice that never happens once you've split; more common is *further* splitting when a phase itself grows too big. The trigger is measured, not aesthetic: I'd collapse if I could ship the same behavior with one prompt and no measurable regression in eval. If not, the split is earned.

Diagram: the reverse gate — "phases collapsing back to one".
Anchor: general reasoning; refers to the eval infra in `04-agent-infrastructure/04-agent-evaluation.md`.

## See also

- `02-supervisor-worker.md` — the topology this repo uses once it passes the gate.
- `03-sequential-pipeline.md` — the diagnose→recommend chain shape.
- `09-coordination-failure-modes.md` — the 2-5x cost, made concrete with specific failures.
- `06-orchestration-system-design-templates/` — the three templates as buildable targets.
