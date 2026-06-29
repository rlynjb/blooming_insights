# Audit — agent architecture in `blooming_insights`

A pattern-by-pattern walk against every concept in the spec. One line per pattern when the verdict is `not yet exercised`; longer when the codebase has something to say.

## Section A — reasoning patterns

### Chains vs agents (the boundary)

**Exercised.** The repo straddles the boundary on purpose: workflow outside, agent inside. The route handlers are chains (`app/api/briefing/route.ts:208-289`, `app/api/agent/route.ts:220-302`); each agent class wraps a ReAct loop (`runAgentLoop` in `node_modules/@aptkit/.../runtime/dist/src/run-agent-loop.js:20`). See `01-reasoning-patterns/01-chains-vs-agents.md`.

### The agent loop skeleton

**Exercised.** Every active agent (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) is one instance of `runAgentLoop`. The four load-bearing parts (`state / step / execute / terminate`) are all in `run-agent-loop.js`. The termination has BOTH exits: `toolUses.length === 0 → finalText = text; break` (success) and `for (let turn = 0; turn < maxTurns; turn += 1)` (budget). See `01-reasoning-patterns/02-agent-loop-skeleton.md`.

### ReAct

**Exercised — this is the default pattern for every agent in the repo.** The Thought-Action-Observation loop is what `runAgentLoop` runs: model emits text (Thought) + `tool_use` (Action) → harness calls `tools.callTool` (Action execution) → result goes back as a `tool_result` content block (Observation) → next turn. See `01-reasoning-patterns/03-react.md`.

### Plan-and-execute

**Not yet exercised.** No agent in the repo separates a planning phase from an execution phase. The diagnostic agent comes closest in concept (test hypotheses, gather evidence, conclude), but the implementation is straight ReAct — there's no plan structure built up front. See `01-reasoning-patterns/04-plan-and-execute.md` for when this would earn its place.

### Reflexion / self-critique loop

**Not yet exercised.** No model second-passes another model's output. The recovery prompt in `runAgentLoop` (lines 106-114) re-asks the same model when the structured-output parser fails — that is *recovery*, not self-critique. See `01-reasoning-patterns/05-reflexion-self-critique.md`.

### Tree of thoughts

**Not yet exercised.** No branch-and-score in the repo, and there's no reason to add it for this domain. See `01-reasoning-patterns/06-tree-of-thoughts.md`.

### Routing

**Exercised — but heuristic + LLM at one layer only.** The QueryBox path runs `classifyIntent` (Haiku, single-shot) to pick `query` vs `investigation` before committing to a loop. There's no second layer of routing inside an agent (no supervisor picking which sub-agent to run). See `01-reasoning-patterns/07-routing.md`.

## Section B — agentic retrieval

### Agentic RAG

**Partially exercised — but it's not vector RAG.** The agents do drive their own data retrieval (the model picks which EQL query to run, observes the result, decides whether to query again). The mechanic is agentic, the substrate is wrong for the canonical RAG framing: there's no embedding index, no chunking, no vector DB. It's *agentic structured-data retrieval over MCP*. See `02-agentic-retrieval/01-agentic-rag.md`.

### Self-corrective RAG

**Not exercised.** No grader between retrieval and generation. The closest equivalent — the structured-output validator (`tryParseAnomalies`) — runs after generation, not after retrieval. See `02-agentic-retrieval/02-self-corrective-rag.md`.

### Retrieval routing

**Partially exercised, at the tool-allowlist level.** Each agent's `allowedTools` policy is a coarse form of retrieval routing — monitoring sees 4 tools, diagnostic sees 11, recommendation sees 14, query sees 33. The model picks within its allowlist; the routing across "knowledge sources" (vector DB / SQL / web) doesn't apply because the repo has one knowledge source (Bloomreach). See `02-agentic-retrieval/03-retrieval-routing.md`.

## Section C — multi-agent orchestration

### When NOT to go multi-agent

**Exercised — this is the load-bearing decision in this repo.** The orchestration is sequential code, not an LLM supervisor. The pipeline (`monitoring → diagnostic → recommendation`) splits along *capability boundaries that map to UI screens*, not along reasoning specialties that need an LLM to coordinate them. See `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — this is the file that makes the deliberate non-escalation legible.

### Supervisor-worker

**Not exercised.** No LLM-driven supervisor. The route handler IS the supervisor in role, but it's deterministic code, not a model. See `03-multi-agent-orchestration/02-supervisor-worker.md`.

### Sequential / pipeline

**Exercised at the orchestration layer.** Three agents run in order; the diagnostic's `Diagnosis` is handed to the recommendation. The handoff between step 2 and step 3 is *client-side* (sessionStorage), which is unusual — see `03-multi-agent-orchestration/03-sequential-pipeline.md`.

### Parallel / fan-out

**Not exercised.** The repo never runs two agents concurrently. Even the monitoring agent's bounded scan is sequential (one tool call at a time inside one loop). See `03-multi-agent-orchestration/04-parallel-fan-out.md`.

### Debate / verifier-critic

**Not exercised.** See `03-multi-agent-orchestration/05-debate-verifier-critic.md`.

### Swarm / handoff

**Not exercised.** See `03-multi-agent-orchestration/06-swarm-handoff.md`.

### Graph orchestration

**Not exercised.** No LangGraph, no state machine, no checkpoint. See `03-multi-agent-orchestration/07-graph-orchestration.md`.

### Shared state and message passing

**Partially exercised — message passing.** Each agent receives its predecessor's typed output (`Anomaly → Diagnosis → Recommendation[]`); no shared blackboard. The chosen model is exactly what the spec recommends. See `03-multi-agent-orchestration/08-shared-state-and-message-passing.md`.

### Coordination failure modes

**Some prevented by topology choice.** No infinite handoff is possible (no peer-to-peer handoff). Tool-call cascade is bounded by `maxToolCalls=6` (monitoring) and `maxTurns=8` (everywhere). Cost blowup is bounded by `maxDuration=300s` per route. Synthesis failure isn't a vector here (no LLM merger). See `03-multi-agent-orchestration/09-coordination-failure-modes.md`.

## Section D — agent infrastructure

### Context engineering

**Exercised — the schema-summary trick is the load-bearing instance.** `schemaSummary` in `lib/agents/monitoring.ts:19-60` (and the AptKit equivalents) hand the agent a token-bounded summary of the workspace — top 20 events, top 10 properties each, top 30 customer properties — instead of the raw 112KB schema. This is curation of what fills the window, not a bigger window. See `04-agent-infrastructure/01-context-engineering.md`.

### Agent memory tiers

**Working memory only.** No episodic, no long-term. The 60s tool-call cache in `BloomreachDataSource` is not memory in the agent-memory sense — it's a performance cache scoped to the data source. See `04-agent-infrastructure/02-agent-memory-tiers.md`.

### Tool calling and MCP

**Exercised, deeply.** MCP is the connective tissue: one MCP server (`https://loomi-mcp-alpha.bloomreach.com/mcp`), one workspace, ~33 tools exposed. The agents call them via the AptKit `ToolRegistry` port, adapted from the Blooming `DataSource` port (`lib/agents/aptkit-adapters.ts:75-97`). The full MCP wire path is in `lib/data-source/bloomreach-data-source.ts` + `lib/mcp/transport.ts`. See `04-agent-infrastructure/03-tool-calling-and-mcp.md`.

### Agent evaluation

**Exercised — Vitest with injected fakes.** 144 tests. Every agent class has a `test/agents/*.test.ts` that constructs a fake `ModelProvider` returning scripted Anthropic content blocks, a fake `DataSource`, and asserts on the trajectory. No LLM-as-judge in the eval surface. No frozen golden trajectories from a real run — the fakes are synthetic. See `04-agent-infrastructure/04-agent-evaluation.md`.

### Guardrails and control

**Exercised — control envelope is the strongest part.** Iteration cap, tool-call cap, token cap per turn, per-agent tool allowlist, per-call AbortSignal, per-call 30s transport timeout, per-route 300s Vercel ceiling. Output guardrail: structured-output validators + recovery prompt. The agent's output never triggers side effects directly (the recommendations are *proposals* in the UI, not actions). See `04-agent-infrastructure/05-guardrails-and-control.md`.

## Section E — production serving for agents

### Cross-turn caching

**Exercised at two layers.** Anthropic prompt-prefix caching is implicit (the system prompt + tool definitions are stable across turns within a run). Intra-run memoization happens inside `BloomreachDataSource.callTool` — keyed by `name:JSON.stringify(args)`, 60s TTL — so a re-derived sub-query within the same agent run is free. No cross-run semantic cache. See `05-production-serving/01-cross-turn-caching.md`.

### Fan-out backpressure

**Not exercised — but the proactive spacing primitive is in place.** The repo never fans out (no parallel agents), so there's no place that issues many concurrent provider calls. But `BloomreachDataSource` enforces `minIntervalMs=200ms` between MCP calls and rate-limit retry up to 3× — the same primitive a fan-out cap would use. See `05-production-serving/02-fan-out-backpressure.md`.

### Per-tool circuit breaking

**Partially exercised — retry, not break.** `BloomreachDataSource` honors the server's stated retry window (parses "retry after N seconds" from the error envelope), sleeps, retries up to `maxRetries=3`. There is no circuit-state machine (closed / open / half-open) per tool. The pattern that *is* in place: when a retry exhausts, the error is wrapped as `McpToolError` and surfaces to the agent as an `is_error: true` `tool_result`, which the model can route around. See `05-production-serving/03-per-tool-circuit-breaking.md`.

## Section F — orchestration system design templates

All three templates are generated regardless of fit, with an honest "Applies to this codebase" verdict. See:

- `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — partial fit (synthesis is the missing piece)
- `06-orchestration-system-design-templates/02-agentic-support-system.md` — partial fit (no action-taking, recommendations are proposals)
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — no fit
