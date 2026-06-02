# 03 · Multi-agent orchestration

> The load-bearing sub-section: blooming insights IS multi-agent — four agents (monitoring/diagnostic/recommendation/query) share `runAgentLoop` (`lib/agents/base.ts` L48–L176) — but deliberately minimal. The route file (`app/api/agent/route.ts` L199–L249) is a hard-coded supervisor; there is no autonomous LLM supervisor, no peer handoff, no LLM merge, no shared blackboard. All nine topology files are in-scope; the codebase exercises 3 of them (Case A: 03 sequential pipeline, 08 message passing, 09 coordination failure modes), names the rest as deferred-by-architectural-choice (Case B), and pins each Case B file to the refactor path in `../06-orchestration-system-design-templates/`.

---

## Reading order

The sub-section reads in two passes — the boundary first, then this codebase's choices, then the topologies you'd reach for at the breakpoint.

```
                           ┌──────────────────────────────────┐
                           │ 01 — when NOT to go multi-agent  │  THE BOUNDARY FILE
                           │     (the escalation gate)         │   read first, always
                           └────────────────┬─────────────────┘
                                            │
                                            ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │ This codebase's choices (Case A — what's implemented)                     │
   │                                                                           │
   │  03 — sequential pipeline      (THE primary topology)                     │
   │  08 — shared state vs message  (message passing; typed Diagnosis)         │
   │       passing                                                             │
   │  09 — coordination failure     (3 structurally absent, 3 mechanically     │
   │       modes                     controlled)                               │
   └───────────────────────────────┬───────────────────────────────────────────┘
                                   │
                                   ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │ The topologies you'd reach for at the breakpoint (Case B — deferred)      │
   │                                                                           │
   │  02 — supervisor-worker        (route is hard-coded supervisor; no LLM   │
   │                                 supervisor)                               │
   │  04 — parallel fan-out          (pipeline is sequential; rate-limit       │
   │                                 makes wide concurrency a poor fit)        │
   │  05 — debate / verifier-critic  (forced-synthesis is re-pass, not critic)│
   │  06 — swarm / handoff           (control centralized in route; no peer    │
   │                                 handoff)                                  │
   │  07 — graph orchestration       (imperative route, not a state graph;     │
   │                                 ProcessStepper is UI, NOT a runtime)      │
   └───────────────────────────────────────────────────────────────────────────┘
```

**blooming insights implements:** `03 + 08 + 09` (sequential pipeline + message passing + the failure-mode controls).

**blooming insights uses deterministic orchestration instead of:** `02 + 06 + 07` (no LLM supervisor, no peer handoff, no graph runtime — see `01-when-not-to-go-multi-agent.md` for the architectural argument).

**blooming insights defers, with named breakpoints:** `04 + 05` (no fan-out under the ~1 req/s MCP rate limit; no verifier-critic without measurable error rate AND a different-model-family critic).

---

## Files

### 01 — When NOT to go multi-agent (`01-when-not-to-go-multi-agent.md`)

**Case:** A — architectural-opinion file.
The escalation gate: single-agent baseline → measure → SPECIFIC decomposable failure → escalate to the SPECIFIC topology. blooming insights crossed the gate by *responsibility* (four specialists with separate prompts and tool subsets) but stopped short of autonomous coordination (no LLM supervisor, no autonomous handoff). Earns the senior answer: "I split into specialists but kept orchestration deterministic, because the coordination didn't need an LLM to decide it."

### 02 — Supervisor-worker (`02-supervisor-worker.md`)

**Case:** B — no LLM supervisor.
Honest nuance: the route file is a *hard-coded supervisor* (code decomposes the user journey, picks the agent), but it's not an agent. Teaches tools-style vs handoff-style; the breakpoint is when routing/synthesis needs model judgment, not a fixed sequence.

### 03 — Sequential pipeline (`03-sequential-pipeline.md`)

**Case:** A — THE primary topology.
monitoring → diagnostic → recommendation as agents-as-pipeline-stages; typed `Diagnosis` as the handoff message; user-gated transitions; per-stage prompt + tool subset + budget (6/6/4). The bridge: a `.then()` chain where each fn is an agent. Cost: latency = sum of stages.

### 04 — Parallel fan-out (`04-parallel-fan-out.md`)

**Case:** B — pipeline is sequential + user-gated.
The ~1 req/s MCP rate limit (`connect.ts` L92, `minIntervalMs: 1100`) makes wide concurrency a poor fit. Bridge: `Promise.all()` + merge. Breakpoint: independent sub-questions across multiple domains where parallel latency beats rate-limit cost. Cross-ref `../05-production-serving/02-fan-out-backpressure.md`.

### 05 — Debate / verifier-critic (`05-debate-verifier-critic.md`)

**Case:** B — no debate or critic agent.
Honest nuance: the forced-synthesis turn in `runAgentLoop` (`base.ts` L90–L101) is a *re-pass on the same model on the same trajectory* — not a separate critic. Names the "critic from same model family shares blind spots" failure (cross-ref `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`). Breakpoint: high-stakes output where a second perspective measurably catches errors AND a different-family critic is available.

### 06 — Swarm / handoff (`06-swarm-handoff.md`)

**Case:** B — control is centralized in the deterministic route; no peer model-decided handoff.
No agent has a `transfer_to_<peer>` tool (`lib/mcp/tools.ts` has no such tools anywhere). Names infinite-handoff failure (cross-ref `./09-coordination-failure-modes.md`). Breakpoint: peer specialists where model-decided handoffs beat a fixed sequence.

### 07 — Graph orchestration (`07-graph-orchestration.md`)

**Case:** B — orchestration is imperative route code, not a checkpointed agent-state graph.
Honest nuance: the UI ProcessStepper is a UI state machine, NOT an agent-orchestration graph runtime. Bridge: a multi-step-form's UI state machine, but the state is shared agent context. Win: debuggability + human-in-the-loop pause/resume + first-class resumability via checkpointing.

### 08 — Shared state and message passing (`08-shared-state-and-message-passing.md`)

**Case:** A — blooming insights uses MESSAGE PASSING.
The typed `Diagnosis` is the message; carriers are function args (in-process) and `sessionStorage 'bi:diag:<id>'` + URL query param (cross-request). `parseDiagnosis()` validates the shape at the trust boundary. Each agent's context is scoped to what it's handed. Scoped context = cheaper + less noise + type-safe; the cost is up-front schema design.

### 09 — Coordination failure modes (`09-coordination-failure-modes.md`)

**Case:** A — walks the failure table; names which failures blooming insights' design PREVENTS structurally vs CONTROLS mechanically.
- **Structurally absent:** infinite handoff (no `transfer_to_*` tools), synthesis failure (no LLM merge — function-call handoffs only), context bloat (message passing, not shared state).
- **Mechanically controlled:** tool-call cascade (per-agent `maxToolCalls` caps 6/6/6/4 + forced-final-turn at `base.ts` L90), cost blowup (Haiku classifier + Sonnet workers + per-stage budgets), token revocation mid-run (one-time guarded auto-reconnect via `sessionStorage 'bi:reconnecting'`).
- **Thesis:** deterministic orchestration buys you fewer failure modes — not by being less powerful, but by structurally not allowing the failures autonomous coordination introduces.

---

## Cross-references (paths relative to this README)

- Systems-view of the same architecture: `../../study-system-design/06-multi-agent-orchestration.md`
- Cross-request handoff (UX + system shape): `../../study-system-design/07-client-stream-handoff.md`
- Agents-vs-chains mechanics (per-loop): `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`
- LLM-as-judge bias (the verifier-critic failure mode): `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`
- Sibling sub-sections in this guide:
  - `../01-reasoning-patterns/` — ReAct, chain-vs-agent boundary at the per-loop level
  - `../02-agentic-retrieval/` — retrieval as the agent's input shape
  - `../04-agent-infrastructure/` — context engineering, agent memory, tool calling, evaluation, guardrails
  - `../05-production-serving/` — cross-turn caching, fan-out backpressure, per-tool circuit breaking
  - `../06-orchestration-system-design-templates/` — the refactor targets for every Case B file in this sub-section

---
Updated: 2026-05-29 — created
