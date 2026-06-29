# 03 · Multi-agent orchestration

Everything above one agent. **The load-bearing section for this repo** — this is where the "minimal multi-agent" shape lives.

## Files

1. [`01-when-not-to-go-multi-agent.md`](./01-when-not-to-go-multi-agent.md) — the most important multi-agent decision (READ FIRST)
2. [`02-supervisor-worker.md`](./02-supervisor-worker.md) — the common topology; this repo's *route handler* fills the supervisor slot deterministically
3. [`03-sequential-pipeline.md`](./03-sequential-pipeline.md) — **THE pattern this repo uses** (monitoring → diagnostic → recommendation)
4. [`04-parallel-fan-out.md`](./04-parallel-fan-out.md) — not in this repo; would require concurrency-cap work
5. [`05-debate-verifier-critic.md`](./05-debate-verifier-critic.md) — not in this repo; the human reading the StatusLog is the critic
6. [`06-swarm-handoff.md`](./06-swarm-handoff.md) — not in this repo; orchestration is deterministic
7. [`07-graph-orchestration.md`](./07-graph-orchestration.md) — not in this repo; the "graph" is the URL routing table
8. [`08-shared-state-and-message-passing.md`](./08-shared-state-and-message-passing.md) — this repo uses message passing (per-request URL params + sessionStorage)
9. [`09-coordination-failure-modes.md`](./09-coordination-failure-modes.md) — most don't show up because the orchestration is deterministic, but the cost-blowup ones do

## How this maps to the codebase

| File | In this codebase? |
|---|---|
| When not to go multi-agent | **Yes — read first.** This repo deliberately went *minimal* multi-agent: one ReAct loop per pipeline stage, no supervisor LLM, no fan-out, no debate. |
| Supervisor-worker | **No (LLM-supervisor)** but **Yes (code-supervisor)**. The supervisor (`app/api/agent/route.ts`) is written in TypeScript, not as an LLM agent. |
| Sequential pipeline | **Yes.** monitoring → diagnostic → recommendation, with a hard split at the HTTP boundary between step 2 and step 3. |
| Parallel fan-out | **No.** No agent fans out work to concurrent workers. Bloomreach's ~1 req/s rate limit makes parallel calls infeasible without a concurrency cap. |
| Debate / verifier-critic | **No.** The diagnosis is final; the human reading the StatusLog is the critic. |
| Swarm / handoff | **No.** Agents don't transfer control to each other. The route does. |
| Graph orchestration | **No** (in the LangGraph sense). The "graph" is the URL routing table — `if (step === 'recommend')` is the graph edge. |
| Shared state & message passing | **Message passing**, by force of architecture (Vercel serverless = ephemeral instances). |
| Coordination failure modes | **Some apply.** Tool-call cascade, cost blowup, synthesis failure — the rest (infinite handoff, context bloat from blackboard) don't show up because the topology forbids them. |
