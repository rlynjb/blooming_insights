# Agent patterns in `blooming_insights`

What this repo actually exercises, as a table you can scan in 30 seconds. Each row is a real loop or piece of orchestration in the code, named by the pattern, anchored to the file.

## The table

```
  Feature                       Pattern / shape              Why this pattern
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  monitoring agent              single-agent ReAct loop      dynamic path — model picks
  (lib/agents/monitoring.ts     (8 turns, 6 tool calls)      which EQL queries to run
   → AptKit AnomalyMonitoring                                against the runnable categories
   Agent)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  diagnostic agent              single-agent ReAct loop      dynamic path — hypothesis-
  (lib/agents/diagnostic.ts                                  testing against the workspace
   → AptKit DiagnosticInvest-                                until evidence is sufficient
   igationAgent)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  recommendation agent          single-agent ReAct loop      dynamic path — reads scenarios
  (lib/agents/recommendation                                 / segments / campaigns from
   .ts → AptKit Recommend-                                   Bloomreach before proposing
   ationAgent)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  query agent                   single-agent ReAct loop      free-form Q&A — wide tool
  (lib/agents/query.ts                                       allowlist (33 tools), the
   → AptKit QueryAgent)                                      model picks every query
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  intent classifier             single-shot LLM call         deterministic routing — pick
  (lib/agents/intent.ts                                      query vs investigation before
   → @aptkit/core classify-                                  committing to a loop
   Intent, Haiku-backed)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  briefing pipeline             sequential workflow,         schema-gate then scan — the
  (app/api/briefing/route.ts)   deterministic                anomaly checklist is gated by
                                                             schema coverage; only runnable
                                                             categories make it to the LLM
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  investigate pipeline          sequential workflow,         diagnose → recommend, the
  (app/api/agent/route.ts)      deterministic with a         user clicks "see recommend-
                                client-side handoff          ations" between the two steps;
                                                             the diagnosis is handed to
                                                             step 3 via sessionStorage
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  coverage gate                 capability gating            don't ask the LLM to scan
  (lib/agents/categories.ts +   (schema-driven allowlist)    categories the workspace can't
   @aptkit/agent-anomaly-                                    answer — skip the EQL budget
   monitoring categories.js)                                 entirely
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  per-agent tool policy         capability gating            each AptKit agent class
  (anomalyMonitoringToolPolicy, (least-privilege tool        ships a fixed `allowedTools`
   diagnosticInvestigation-     allowlist per agent)         list — the model never sees
   ToolPolicy, recommendation-                               the full 33-tool surface
   ToolPolicy, queryToolPolicy)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  data-source seam              port / adapter               three adapters total (Bloom-
  (lib/data-source/types.ts +   (dependency inversion)       reach over MCP, synthetic
   factory in index.ts)                                      in-memory, plus an in-memory
                                                             ToolRegistry for tests)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  cross-turn caching            production serving           prompt prefix (provider-side
  (BloomreachDataSource         (three layers)               at Anthropic) + intra-run
   60s cache + Anthropic                                     memoization (the 60s cache,
   prompt prefix)                                            keyed by name + args)
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  per-tool rate-limit retry     production serving           BloomreachDataSource parses
  (BloomreachDataSource         (per-tool circuit break-     "retry after N seconds" from
   retry ladder)                ish — retry, not break)      the error envelope, sleeps,
                                                             retries up to 3×; failure
                                                             surfaces to the agent as an
                                                             error tool_result the model
                                                             can route around
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  budget exit                   load-bearing skeleton        every agent: maxTurns=8,
  (run-agent-loop.js in         part                         maxToolCalls=6 (monitoring),
   @aptkit/runtime)                                          maxTokens=4096 — the model
                                                             can't burn budget in a silent
                                                             loop
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  synthesis instruction         load-bearing skeleton        on the final turn, tools are
  ("forced final turn")         part                         removed from the request and
                                                             a "you have no more tool
                                                             calls" instruction is added —
                                                             the model has to synthesize,
                                                             not call another tool
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  recovery prompt               agent infrastructure         monitoring agent only — if
  (parseResult returns null →   (structured-output           tryParseAnomalies can't find
   recoveryPrompt fires)        recovery)                    a JSON array, a recovery
                                                             prompt restates the evidence
                                                             and asks for ONLY the JSON
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  capability trace sink         agent infrastructure         CapabilityEvent stream (step,
  (BloomingTraceSinkAdapter →   (observable trajectory)      tool_call_start / _end, etc.)
   AgentEvent NDJSON →                                       crosses three boundaries:
   StatusLog UI)                                             AptKit → Blooming hooks →
                                                             NDJSON wire → UI
  ─────────────────────────────  ─────────────────────────    ──────────────────────────────
  Vitest with injected fakes    agent evaluation             test ReAct loops without
  (144 tests, no network)       (deterministic eval)         network — fake ModelProvider
                                                             responds with scripted tool-
                                                             use blocks; fake ToolRegistry
                                                             returns canned results
```

## What this repo does NOT use

Listing the absences honestly — these are the patterns covered in the rest of the guide that this repo deliberately or incidentally does not run:

- **No LLM supervisor.** The intent classifier picks query vs investigation, but it does not orchestrate sub-agents. The briefing → diagnose → recommend pipeline is deterministic code.
- **No debate / verifier-critic.** A second model never grades the first's output.
- **No swarm / handoff.** Agents don't transfer control to each other; the deterministic orchestrator hands the next agent the previous agent's typed output.
- **No graph orchestration.** No LangGraph, no state machine, no checkpointing. The handoff between diagnose (step 2) and recommend (step 3) is a `sessionStorage` write in the browser — not server-side resumable state.
- **No plan-and-execute.** Every agent is straight ReAct; no agent builds a plan up front and then executes it.
- **No reflexion / self-critique loop.** No model second-passes its own output.
- **No tree-of-thoughts.** No branching exploration.
- **No agent memory across runs.** Each agent run is fresh; the only cross-run state is the BloomreachDataSource's 60s tool-call cache (not memory in the agent-memory sense).
- **No vector store / RAG.** The repo does not embed anything. The "retrieval" is the agent calling MCP tools to pull EQL results from Bloomreach in real time.
- **No MCP outside Bloomreach.** One MCP server, one workspace. The MCP protocol matters here because it's the substrate every tool sits on; the *multi-server MCP* pattern doesn't apply.
- **No human-in-the-loop pause.** Every loop runs to completion or budget; the only "human" is the user clicking "see recommendations" between step 2 and step 3, which is a deterministic pipeline boundary, not a model-gated approval.

## The control envelope, at a glance

Every agent runs inside the same envelope. Specifics live in `04-agent-infrastructure/05-guardrails-and-control.md`; here's the summary so you can see the shape:

```
  ┌─ Input guardrail ─────────────────────────────────┐
  │  schema-coverage gate (monitoring only)            │
  │  intent classifier (query agent only)              │
  │  no input sanitization on the user's free-form q   │
  └─────────────────────────────────────────────────┘

  ┌─ Agent loop (every agent) ─────────────────────────┐
  │  maxTurns = 8                                      │
  │  maxToolCalls = 6 (monitoring only) — others       │
  │    are bounded by maxTurns only                    │
  │  maxTokens = 4096 per turn                         │
  │  per-agent allowedTools (4 / 11 / 14 / 33 tools)   │
  │  per-call AbortSignal threaded from the route     │
  │  per-call 30s MCP transport timeout                │
  │  per-route Vercel maxDuration = 300s               │
  └─────────────────────────────────────────────────┘

  ┌─ Output guardrail ─────────────────────────────────┐
  │  tryParseAnomalies / tryParseDiagnosis /           │
  │  recommendation validate — structured-output        │
  │  validators run on the final text; failure         │
  │  triggers the recovery prompt or returns []        │
  │  the agent's output never triggers side effects    │
  │  directly — recommendations are proposals the user │
  │  reads, not actions the system takes               │
  └─────────────────────────────────────────────────┘
```

## The eval, at a glance

`vitest` with injected fakes. The agent loops are TDD'd: each `test/agents/*.test.ts` file constructs a fake `ModelProvider` that returns scripted Anthropic content blocks (a `tool_use` block, then a `text` block with the final JSON), a fake `ToolRegistry` (or the real `BloomingToolRegistryAdapter` against a fake `DataSource`), and asserts on the trajectory. No network, no API key. 144 tests pass.

This is the "trajectory eval" surface from `04-agent-infrastructure/04-agent-evaluation.md` — the unit of test is the trajectory (which tools, in what order, with what final output), not just the final output.
