# 03 — Multi-agent orchestration

Anchor: **multi-agent** (primary)

This is the load-bearing new material. Everything above one agent.

## Reading order

The first file comes first by design — the single most important multi-agent decision is whether to be multi-agent at all.

1. **[01-when-not-to-go-multi-agent.md](./01-when-not-to-go-multi-agent.md)** — the escalation gate. Start here.
2. **[02-supervisor-worker.md](./02-supervisor-worker.md)** — the topology this repo uses (code-routed variant).
3. **[03-sequential-pipeline.md](./03-sequential-pipeline.md)** — diagnostic → recommendation is this shape.
4. **[04-parallel-fan-out.md](./04-parallel-fan-out.md)** — the latency lever this repo doesn't use.
5. **[05-debate-verifier-critic.md](./05-debate-verifier-critic.md)** — quality lever; offline-only here.
6. **[06-swarm-handoff.md](./06-swarm-handoff.md)** — peer control transfer; deliberately not used.
7. **[07-graph-orchestration.md](./07-graph-orchestration.md)** — explicit state machine; the alternative to inline route sequencing.
8. **[08-shared-state-and-message-passing.md](./08-shared-state-and-message-passing.md)** — how agents communicate.
9. **[09-coordination-failure-modes.md](./09-coordination-failure-modes.md)** — where the 2-5x overhead shows up, and how to bound it.

## The through-line

Every topology in this section is a *shape* first — the diagram IS the mental model. Prose fills in the coordination mechanism, then names the overhead it buys and what it buys with it.

**This repo is multi-agent, code-routed.** A route handler is the supervisor. The subsections here weight toward that shape:

- **02-supervisor-worker** and **03-sequential-pipeline** get the full walk with real file paths — these are the topologies this repo instantiates.
- **04-parallel**, **05-debate**, **07-graph** get "not yet implemented" with a concrete refactor spec in each file's Move 2 and in Section 06 templates.
- **06-swarm-handoff** gets full coverage of the pattern + the honest reason it's not used here.
- **08-shared-state** and **09-coordination-failures** are cross-cutting concerns that apply to every topology, including the ones this repo does use.
