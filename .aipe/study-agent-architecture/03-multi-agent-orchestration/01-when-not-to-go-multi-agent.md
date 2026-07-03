# When NOT to go multi-agent

*Industry name: single-agent-first / the escalation gate · Language-agnostic*

## Zoom out

```
  Zoom out — the gate before every SECTION C topology

  ┌─ single-agent (ReAct) baseline ──────────────┐
  │  is it hitting a specific ceiling?           │
  └─────────────────┬────────────────────────────┘
                    ▼
  ┌─ ★ THE GATE ★ ────────────────────────────────┐ ← we are here
  │  Is the failure genuinely decomposable        │
  │  into independent specialties?                │
  └─────────────────┬────────────────────────────┘
       yes ─────────┴─────── no
       ▼                     ▼
   escalate to           stay single-agent
   a specific            (fix prompt / tools /
   topology              retrieval instead)
```

## Zoom in

The single most important multi-agent decision is whether to be multi-agent at all. Multi-agent adds roughly **2-5x coordination overhead** and a much larger debugging surface. The quality gain is often modest unless the problem genuinely splits into specialties. This file is here to earn you the senior-grade answer: "I considered multi-agent and chose not to, because the failure wasn't decomposable."

## Structure pass

Layers: **baseline** (single-agent ReAct) — **measurement** (concrete failure modes) — **decomposability test** — **topology pick**.

Axis to hold constant: **what specific failure does escalation fix?**

If you can't name one, you're paying 2-5x overhead for nothing. That's the whole gate.

## How it works

### Move 1 — the shape

You've resisted refactoring a working component because "it's fine as-is." Same instinct here. The premature-multi-agent instinct is the same as the premature-abstraction instinct: it feels sophisticated, adds surface area, and rarely improves outcomes on the current problem.

```
  The escalation gate — four steps, in order

  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline      │
  │ 2. Measure: success rate, tool-call accuracy, │
  │    latency, cost                              │
  │ 3. Identify the SPECIFIC failure single-agent │
  │    cannot fix                                 │
  │ 4. Is that failure genuinely decomposable     │
  │    into independent specialties?              │
  │       │                                        │
  │       ├─ no  → stay single-agent, fix the      │
  │       │        prompt / tools / retrieval      │
  │       └─ yes → escalate to the SPECIFIC        │
  │                topology that addresses it      │
  └───────────────────────────────────────────────┘
```

### Move 2 — how the gate reads against this repo's decisions

**This repo IS multi-agent, but not the way most people mean.** The four workers (Monitoring, Diagnostic, Recommendation, Query) are specialized agents — that's multi-agent by construction. But the supervisor is *code*, not an LLM. So the decisions the gate would test are:

1. Was decomposing "the analyst" into four agents worth the coordination cost? — **Yes.** Each specialty has a different job (find anomalies vs form hypotheses vs propose actions vs answer free-form). Prompts are different, tool selection preferences are different, output shapes are different. This is decomposable in the load-bearing sense.

2. Would adding an LLM supervisor on top be worth it? — **No.** The supervisor sequence is three well-known stages (monitor → diagnose → recommend). A Sonnet-based supervisor decision would cost ~$0.05 per hop, add ~2-3s latency, and buy nothing — the sequence is stable across every anomaly type. The correct decision is **code-routed multi-agent**: specialists at the worker layer, deterministic sequencing at the supervisor layer.

3. Would adding a second worker per specialty (fan-out) buy quality? — **Not yet measured.** The diagnostic path could parallelize hypothesis testing (three hypotheses in parallel, three EQLs, merge findings). That's a real escalation candidate. The current diagnostic p50 is 50s; parallel would target ~20s. Deferred until the latency budget matters.

**The cost concretized.**

```
  What "2-5x coordination overhead" actually means

  Single-agent (ReAct):        1 model call per turn
                               state = one message history
                               debugging = one loop trace

  Multi-agent w/ LLM sup:      1 supervisor call + N worker calls per hop
                               state = supervisor's view + N worker views
                               debugging = supervisor decisions +
                                           each worker's loop
                               cost:  ~2-3x tokens
                               debug: ~5x surface area
                                      (you now debug a conversation
                                       between agents, not one loop)

  Multi-agent code-routed:     0 supervisor cost (deterministic)
                               N worker calls per hop
                               state = per-worker views, route ties them
                               debugging = per-worker + route sequence
                               cost:  ~1-1.5x vs one big ReAct agent
                                      (specialization can save tokens
                                       per worker)
                               debug: ~2x surface area
```

Code-routed is the sweet spot when the sequence is stable. LLM-routed is worth it when the sequence itself needs to adapt — which is rarer than teams initially think.

**The failures that ARE decomposable (rare escalations).**

- **Specialists with genuinely different tools.** A code agent (reads files, runs tests) and a review agent (runs linters, checks style) — different tool sets, different prompts, different success criteria. Worth splitting.
- **Parallel independent subtasks.** A research question with three independent sub-sources — worth fan-out.
- **Producer-critic asymmetry.** Output quality is uneven and a critic from a different model family catches errors — worth debate/verifier.

**The failures that are NOT decomposable.**

- **"The agent gets confused."** Fix the prompt or the tools; don't add another agent.
- **"The agent forgets."** Fix context engineering (SECTION D); don't add memory-manager-agents.
- **"The agent picks the wrong tool."** Reduce tool count, sharpen tool descriptions, add a pre-router; don't add a tool-picker-agent above it.

### Move 3 — the principle

Multi-agent is not "more sophisticated single-agent." It's a different architecture with real coordination cost. The senior-grade posture is to reach for it only when a specific single-agent failure names itself and the failure genuinely splits into specialties. Naming when you *didn't* escalate is a stronger signal than always escalating.

## Primary diagram

```
  The escalation gate — decision tree

  ┌──────────────────────────────────────────────────────┐
  │                                                       │
  │  Have you shipped ReAct baseline?    ── no ──► ship it│
  │             │ yes                                     │
  │             ▼                                         │
  │  Have you measured its ceiling?      ── no ──► measure│
  │             │ yes                                     │
  │             ▼                                         │
  │  Can you name the specific failure? ── no ──► not     │
  │             │ yes                              ready  │
  │             ▼                                         │
  │  Is it genuinely decomposable       ── no ──► fix     │
  │  into specialties?                             prompt/│
  │             │ yes                              tools/ │
  │             ▼                                  retriev│
  │  Pick the SPECIFIC topology that                      │
  │  addresses that failure:                              │
  │    → supervisor-worker (specialties)                  │
  │    → pipeline (sequential stages)                     │
  │    → fan-out (independent parallel)                   │
  │    → debate (quality gate)                            │
  │    → graph (needs human-in-loop / branching)          │
  └──────────────────────────────────────────────────────┘
```

## Elaborate

The "single-agent-first" rule crystallized around 2024 as teams reported the same pattern: they'd built impressive multi-agent demos, deployed them, and watched cost balloon and reliability drop compared to a well-tuned single agent. Anthropic's "Building Effective Agents" essay (Dec 2024), the OpenAI Cookbook's agent guide, and CrewAI's own documentation now all lead with the same escalation rule.

The counter-example — when multi-agent *is* the right start — is systems where the sub-tasks are so different that combining them into one agent means combining incompatible tool sets or contradictory prompt goals. A codebase-editing agent + a customer-support agent are that different. Diagnostic + recommendation for the same workspace are not — they share tools, share the workspace context, and only differ in the output they produce. Splitting them is warranted (different final structured outputs) but doesn't need an LLM supervisor above them; a code sequence is enough.

## Interview defense

**Q: Why isn't your supervisor an LLM?**

Because the supervisor sequence is stable. Three stages — monitor, diagnose, recommend — with well-known transitions between them (feed → investigate step 2 → step 3). A Sonnet-based supervisor would cost ~$0.05 per hop, add ~2-3s latency, and buy nothing on this decomposition. Code-routed with LLM specialists at the worker layer is the sweet spot.

Where I'd add an LLM supervisor: if the sequence itself started needing to adapt — e.g., some anomalies need diagnose → re-monitor → diagnose loops before recommendation. Right now the sequence is stable, so LLM routing is premature.

*Anchor visual:* the escalation gate diagram above.

**Q: What single-agent failure would push you to multi-agent-with-LLM-supervisor?**

Sequence unpredictability. If the "what to do next" itself depended on the LLM's read of the situation — not just "what tool" but "which whole stage" — then an LLM supervisor earns its cost. For this product, the three stages are what the user chose to see (the ProcessStepper is UI-visible), so the sequence can't change dynamically anyway. The design constrains the shape.

**Q: How do you know when a failure is "decomposable"?**

Different tool sets, different success criteria, or different output shapes. If two hypothetical agents would share the same tools and prompts and just have slightly different framings, they're not decomposable — you have one agent with an inconsistent prompt. If they have genuinely different jobs (analyze data vs propose Bloomreach features), they're decomposable.

## See also

- **`02-supervisor-worker.md`** — the topology this repo picked once the gate cleared.
- **`03-sequential-pipeline.md`** — the sub-shape between diagnostic and recommendation.
- **`09-coordination-failure-modes.md`** — the specific failures that make up the 2-5x cost.
- **`01-reasoning-patterns/03-react.md`** — the baseline you build before this gate applies.
