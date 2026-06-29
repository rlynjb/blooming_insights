# 03 — Multi-agent orchestration

Anchor: multi-agent (primary)

Everything *above* one agent. This is the load-bearing new material in the spec — multi-agent orchestration is the area with the largest gap between "I read about it" and "I shipped it."

## How this maps to the repo

The repo runs a **sequential pipeline of single-agent loops**, dispatched by deterministic TypeScript. There is **no LLM supervisor, no debate, no swarm, no graph orchestration**. The pipeline (`monitoring → diagnose → recommend`) splits along capability boundaries that map to UI screens, not along reasoning specialties that need an LLM to coordinate them.

So the headline file in this sub-section is `01-when-not-to-go-multi-agent.md` — the deliberate non-escalation is the lesson this repo carries. The topology files (supervisor-worker, debate, swarm, graph) are marked "Not yet implemented" honestly, with a system-design template (Section F) naming what the refactor would look like.

Two parts of the sub-section *are* live:

- `03-sequential-pipeline.md` — the briefing → diagnose → recommend pipeline IS a pipeline, just with deterministic code as the "pipe" between stages.
- `08-shared-state-and-message-passing.md` — the repo does message-passing (typed handoffs `Anomaly → Diagnosis → Recommendation[]`), not shared blackboard. The chosen model is exactly what the spec recommends.

## Reading order

1. `01-when-not-to-go-multi-agent.md` — read this first. The most important decision.
2. `02-supervisor-worker.md` — the most common topology if you escalate.
3. `03-sequential-pipeline.md` — the topology this repo's orchestration shape resembles.
4. `04-parallel-fan-out.md` — independent subtasks in parallel.
5. `05-debate-verifier-critic.md` — quality-refinement topology.
6. `06-swarm-handoff.md` — peer-to-peer control transfer.
7. `07-graph-orchestration.md` — making the others inspectable.
8. `08-shared-state-and-message-passing.md` — how agents communicate.
9. `09-coordination-failure-modes.md` — what breaks above one agent.
