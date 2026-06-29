# Agent patterns in this codebase

The critical file. Every agent loop in the repo, named by the pattern it instantiates, with its control envelope. Read this before any sub-section file — the sub-sections explain the patterns; this file says which one each agent is.

## The agent inventory

Five active agent loops, all `runAgentLoop()` inside `@aptkit/core@0.3.0`. Plus one classifier that's a single LLM call (no loop). The Blooming-owned classes are thin wrappers — the bodies are 20-50 lines each, mostly adapter wiring.

| Feature | File | Pattern / shape | Control envelope | Why this pattern |
|---|---|---|---|---|
| Anomaly detection | `lib/agents/monitoring.ts` → AptKit `AnomalyMonitoringAgent` | ReAct (single-agent loop) | `maxTurns=8`, `maxToolCalls=6`, forced-final synthesis | The model decides which categories to probe and in what order; the path isn't predetermined. |
| Cause investigation | `lib/agents/diagnostic.ts` → AptKit `DiagnosticInvestigationAgent` | ReAct (single-agent loop) | `maxTurns=8`, `maxToolCalls=6`, forced-final synthesis | Hypothesis-driven — the model generates 2-3 hypotheses, falsifies each, then concludes. |
| Action proposal | `lib/agents/recommendation.ts` → AptKit `RecommendationAgent` | ReAct (single-agent loop, tighter budget) | `maxTurns=6`, `maxToolCalls=4`, forced-final synthesis | Mostly reasoning from the diagnosis; tool calls only to check what scenarios/segments already exist. |
| Free-form Q&A | `lib/agents/query.ts` → AptKit `QueryAgent` | ReAct (single-agent loop, broadest tool grant) | `maxTurns=8`, `maxToolCalls=6`, forced-final synthesis | Unknown path — the user could ask anything, so the model has to drive. |
| Intent classification | `lib/agents/intent.ts` → AptKit `classifyIntent` | Single LLM call (no loop, no tools) | One call, cheap `claude-haiku-4-5-20251001` | Pure classification: `monitoring` / `diagnostic` / `recommendation`. No tool use, so no loop. |
| Pipeline orchestration | `app/api/agent/route.ts` | Sequential pipeline — DETERMINISTIC route code | `?step=diagnose|recommend` decides | The product workflow is fixed (what changed → why → what to do); the orchestrator is the URL, not an LLM. |
| Briefing orchestration | `app/api/briefing/route.ts` | Schema-gated single-agent invocation | `runnableCategories(capabilities)` feeds the prompt | The route gates the category checklist against the workspace before the agent starts, so the model never wastes budget on unsupported categories. |

## The kernel they all share

Every one of the four loop-shaped agents above is the same `runAgentLoop()` skeleton with a different prompt and tool grant. The loop lives in `@aptkit/core` and is described in `01-reasoning-patterns/02-agent-loop-skeleton.md`. The four invariants — `step → execute → accumulate → terminate` — are identical; only the prompt, tool policy, and budgets differ.

```
  Same skeleton, four prompts, four tool grants

                      ┌────────────────────────────────────┐
   prompt:            │  AptKit runAgentLoop (one impl)    │
   monitoring  ──┐    │                                    │
   diagnostic   ─┼──► │  while not done {                  │
   recommend   ──┤    │    step  ← model.complete(...)     │
   query       ──┘    │    if final → return                │
                      │    result ← tools.callTool(...)     │
   tool policy:       │    state  ← accumulate(result)      │
   ANOMALY_MONITORING │    if budget_spent → force final    │
   DIAGNOSTIC         │  }                                  │
   RECOMMENDATION     └────────────────────────────────────┘
   QUERY                       ▲
                               │
                tool registry (BloomingToolRegistryAdapter)
                       │
                       ▼
                DataSource (Bloomreach | Synthetic)
```

## The orchestration layer — by feature

### Feature: briefing (the feed)

```
  GET /api/briefing — monitoring agent invocation, schema-gated

  ┌───────────────────────────────────────────────────────────────┐
  │  Route handler — app/api/briefing/route.ts                    │
  │                                                                │
  │  1. bootstrap()          → fetch WorkspaceSchema (live MCP)   │
  │  2. schemaCapabilities() → derive what events exist           │
  │  3. coverageReport()     → 10 categories × {full|limited|none}│
  │  4. runnableCategories() → drop unrunnable categories          │
  │  5. dataSource.listTools() → fetch MCP tool catalog            │
  │  6. new MonitoringAgent(...).scan({ ..., }, runnable)         │
  │       └─► AptKit AnomalyMonitoringAgent.scan()                │
  │             └─► runAgentLoop(maxTurns=8, maxToolCalls=6)      │
  │                  → up to 6 EQL queries via Bloomreach          │
  │                  → forced JSON synthesis on turn 8 or budget   │
  │  7. anomalies.map(anomalyToInsight) → stream as `insight`     │
  └───────────────────────────────────────────────────────────────┘

  Pattern: single-agent ReAct. Control envelope: schema-gated
  category list narrows the search space BEFORE the model starts.
```

### Feature: investigation step 2 (diagnose)

```
  GET /api/agent?insightId=X&step=diagnose — diagnostic agent only

  ┌───────────────────────────────────────────────────────────────┐
  │  Route handler — app/api/agent/route.ts                       │
  │                                                                │
  │  1. resolveAnomaly(insightId, insightParam)                   │
  │       → prefers client-passed insight (survives Vercel cold)  │
  │       → falls back to in-memory state, then demo snapshot     │
  │  2. bootstrap() + listTools() (inside the stream)             │
  │  3. new DiagnosticAgent(...).investigate(anomaly)             │
  │       └─► AptKit DiagnosticInvestigationAgent.investigate()   │
  │             └─► runAgentLoop(maxTurns=8, maxToolCalls=6)      │
  │                  prompt: generate 2-3 hypotheses, falsify each │
  │  4. send `diagnosis` event                                    │
  │  5. STOP. Recommendation is NOT run here.                     │
  └───────────────────────────────────────────────────────────────┘

  Pattern: single-agent ReAct. Step 3 is a SEPARATE request — the
  pipeline is split across two HTTP calls so the user reviews the
  diagnosis before recommendations run.
```

### Feature: investigation step 3 (recommend)

```
  GET /api/agent?insightId=X&step=recommend&diagnosis={...}

  ┌───────────────────────────────────────────────────────────────┐
  │  Route handler — app/api/agent/route.ts                       │
  │                                                                │
  │  1. parseDiagnosis(diagnosisParam) — handed over from step 2   │
  │     (lives in sessionStorage in the browser between requests) │
  │  2. bootstrap() + listTools()                                 │
  │  3. new RecommendationAgent(...).propose(anomaly, diagnosis)  │
  │       └─► AptKit RecommendationAgent.propose()                │
  │             └─► runAgentLoop(maxTurns=6, maxToolCalls=4)      │
  │                  TIGHTER budget — mostly reasoning, few tools │
  │  4. stream `recommendation` events (up to 3)                  │
  └───────────────────────────────────────────────────────────────┘

  Pattern: single-agent ReAct with a tighter budget. The diagnosis
  is the upstream agent's output, passed via URL — message passing
  WITHOUT a shared blackboard. Each agent sees only what it needs.
```

### Feature: free-form Q&A

```
  GET /api/agent?q=... — intent classifier then QueryAgent

  ┌───────────────────────────────────────────────────────────────┐
  │  Route handler — app/api/agent/route.ts                       │
  │                                                                │
  │  1. bootstrap() + listTools()                                 │
  │  2. classifyIntent(anthropic, q, sid)                         │
  │       └─► AptKit classifyIntent — ONE haiku-4-5 call, no tools│
  │       returns 'monitoring' | 'diagnostic' | 'recommendation'  │
  │  3. new QueryAgent(...).answer(q, intent)                     │
  │       └─► AptKit QueryAgent.answer()                          │
  │             └─► runAgentLoop(maxTurns=8, maxToolCalls=6)      │
  │                  tool grant is the UNION of all four agents'   │
  │                  policies — broadest tool surface in the repo │
  │  4. stream `reasoning_step` events; final `conclusion` text   │
  └───────────────────────────────────────────────────────────────┘

  Pattern: heuristic-first router (the intent classifier is the
  cheap-and-fast handler that frames the answer) feeding a single
  ReAct loop with the broadest tool grant. The intent classifier
  doesn't pick a different AGENT — it just labels the question
  so the QueryAgent's prompt frames the answer correctly.
```

## The shared control envelope

Every loop carries the same four-part envelope. The numbers differ per agent; the parts don't.

```
  Control envelope — same shape, four agents

  ┌─ INPUT ────────────────────────────────────────────────────┐
  │  schema-gated prompt (monitoring only — categories filtered)│
  │  tool policy (allowedTools per capability)                  │
  └─────────────────────────────┬──────────────────────────────┘
                                ▼
  ┌─ LOOP ─────────────────────────────────────────────────────┐
  │  maxTurns = 6 (recommendation) or 8 (others)                │
  │  maxToolCalls = 4 (recommendation) or 6 (others)            │
  │  on each turn: signal.throwIfAborted() between turns       │
  │  signal threaded into anthropic.messages.create + callTool │
  └─────────────────────────────┬──────────────────────────────┘
                                ▼
  ┌─ TERMINATION ──────────────────────────────────────────────┐
  │  success exit: model emits text with no tool_use blocks     │
  │  budget exit:  maxToolCalls reached → forced-final synthesis│
  │  turn exit:    maxTurns reached → forced-final synthesis    │
  │  recovery:     parseResult fails → one tool-less turn       │
  └─────────────────────────────┬──────────────────────────────┘
                                ▼
  ┌─ OUTPUT ───────────────────────────────────────────────────┐
  │  validated parsed JSON (per-agent shape) OR fallback []     │
  │  trace events emitted into BloomingTraceSinkAdapter         │
  │  trace events become AgentEvent NDJSON on the wire          │
  └────────────────────────────────────────────────────────────┘
```

## How shared state flows between agents

No shared blackboard. Each agent's output is the next agent's input, passed as plain data. Two channels:

```
  Message passing between agents — no shared blackboard

  Channel 1: in-process (capture-only, combined runs)
  ──────────────────────────────────────────────────
  MonitoringAgent.scan() → Anomaly[]
       │
       ▼ in-memory map (lib/state/insights.ts)
       │  per-session, single-instance only
       ▼
  DiagnosticAgent.investigate(anomaly) → Diagnosis
       │
       ▼ in-memory map (lib/state/investigations.ts)
       ▼
  RecommendationAgent.propose(anomaly, diagnosis) → Recommendation[]


  Channel 2: cross-request (production split-step flow)
  ─────────────────────────────────────────────────────
  step 2 response  ── diagnosis ──► browser sessionStorage
                                              │
                                              ▼
  step 3 request   ◄── diagnosis (URL param) ─┘
                            │
                            ▼
                     RecommendationAgent
```

The cross-request channel exists because Vercel's serverless instances are ephemeral — between step 2 and step 3 the user might land on a different instance with no shared memory. Passing the diagnosis through the browser is the only way to guarantee the next step sees it. This is **message passing, not shared state**, by force of architecture.

## The data-source port (`DataSource`)

Every agent's tools route through the same port — the only thing that changes between `live-bloomreach` and `live-synthetic` is *which adapter is injected*. The agent code is identical; the URL `?mode=` parameter picks the adapter.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  makeDataSource(mode, sessionId)                             │
  │    'live-bloomreach' → new BloomreachDataSource(...)         │
  │    'live-synthetic'  → new SyntheticDataSource()             │
  │  returns: { dataSource, bootstrap, dispose }                 │
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  new MonitoringAgent(anthropic, dataSource, schema, allTools)│
  │  new DiagnosticAgent(anthropic, dataSource, schema, allTools)│
  │  new RecommendationAgent(anthropic, dataSource, schema, ...) │
  │  new QueryAgent(anthropic, dataSource, schema, allTools)     │
  └──────────────────────────────────────────────────────────────┘
```

The agents never know they're talking to a Bloomreach MCP server or to an in-process synthetic store. The seam IS the swap.

## What's NOT a pattern in this repo

To save you reading the sub-section files looking for it:

- **No RAG of any kind.** No embeddings, no vector store, no chunking, no similarity search. Retrieval is via Bloomreach EQL tool calls — the model writes the query, the tool runs it, the result comes back as a tool_result block.
- **No supervisor agent.** The orchestrator is `app/api/agent/route.ts` — TypeScript. No LLM decides which agent runs next.
- **No fan-out / parallel agents.** Every loop runs sequentially. The monitoring agent doesn't fan out across categories; the recommendation agent doesn't spawn workers per recommendation.
- **No debate / verifier-critic.** A diagnosis is final. No second agent re-grades it.
- **No swarm / handoff.** Agents don't transfer control to each other — the route does.
- **No graph orchestration.** No LangGraph-style explicit state machine. The "graph" is the URL routing table.
- **No automated trajectory-eval harness.** Eval is reading the streamed AgentEvent trace by eye. (See `04-agent-infrastructure/04-agent-evaluation.md` for what this implies.)
