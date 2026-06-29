# Supervisor-worker

**Industry standard.** The most common and most useful multi-agent topology. **Not exercised** in this codebase — the orchestration is deterministic code, not an LLM supervisor.

## Zoom out, then zoom in

A supervisor agent receives the user's request, decomposes it, dispatches to specialized worker agents, and synthesizes their results.

```
  Zoom out — where this WOULD live

  ┌─ Orchestration layer ───────────────────────────┐
  │  Today: deterministic route handler              │
  │  Would: ★ Supervisor agent ★                    │ ← we are here
  │  (one ReAct loop whose tools ARE the workers)    │
  └────────────────────────────┬────────────────────┘
                               │ dispatches
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        Worker agent     Worker agent     Worker agent
        (specialized)   (specialized)    (specialized)
              └────────────────┬────────────────┘
                               ▼
                       supervisor synthesizes
```

This repo's route handler is the supervisor in *role* (dispatches to workers, sequences them, hands their outputs through) — but it's TypeScript, not an LLM. That distinction is the difference between "workflow orchestration" and "supervisor-worker."

## Structure pass

Layers: supervisor (one agent loop) → workers (N specialized agents) → synthesis (supervisor merges results).

**Axis traced — "who picks which worker runs?":** the supervisor's model. Each turn it emits `tool_use` with the worker's name; the harness dispatches.

**Seam:** workers exposed AS tools to the supervisor. The supervisor calls `run_diagnostic_worker(anomaly)` the same way a regular agent would call `execute_analytics_eql(...)`. The worker is wrapped in a tool definition; the supervisor doesn't know it's calling another agent.

## How it works

### Move 1 — the mental model

You know the manager-component pattern in a frontend app — a `<Dashboard>` parent fetches summary data, then renders `<ChartA>` `<ChartB>` `<ChartC>` children, each owning their detail rendering, and finally aggregates user interactions back up. The supervisor agent is the parent component; the workers are the children. The parent decides which children to mount (which workers to run); each child owns its slice; the parent synthesizes their outputs into the final response.

```
  Supervisor-worker — the shape

  ┌──────────────────────────────────────────────────┐
  │              Supervisor agent                     │
  │   (decomposes task, delegates, synthesizes)      │
  └───────┬───────────────┬───────────────┬──────────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

### Move 2 — step by step

#### What this would look like in this repo

If the repo grew a supervisor, the route handler would become this:

```ts
// hypothetical lib/agents/supervisor.ts (not implemented)
class SupervisorAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: DataSource,
    private schema: WorkspaceSchema,
    // worker constructors injected as factories so the supervisor
    // wraps them in a worker-tool registry
    private workers: WorkerRegistry,
  ) {}

  async handleQuery(query: string): Promise<string> {
    return runAgentLoop({
      capabilityId: 'supervisor',
      model: new AnthropicModelProviderAdapter(this.anthropic, 'coordinator'),
      tools: this.workers,  // workers wrapped as tools
      system: SUPERVISOR_PROMPT,
      userPrompt: query,
      maxTurns: 6,
    });
  }
}

// the workers exposed as tools:
const workers: ToolRegistry = {
  listTools: () => [
    { name: 'run_diagnostic', description: 'investigate one anomaly', inputSchema: { ... } },
    { name: 'run_recommendation', description: 'propose actions from a diagnosis', inputSchema: { ... } },
    // ...
  ],
  callTool: async (name, args) => {
    if (name === 'run_diagnostic') {
      const result = await diagnosticAgent.investigate(args.anomaly);
      return { result, durationMs: ... };
    }
    // ...
  },
};
```

The supervisor's `runAgentLoop` calls workers as tools. Each worker is itself a single-agent ReAct loop — so the supervisor is one agent loop wrapping N inner agent loops. The skeleton from `01-reasoning-patterns/02-agent-loop-skeleton.md` recurses.

#### Tools-style vs handoff-style — the decision to make explicit

Two flavors of supervisor:

- **Tools-style** (the example above): supervisor stays in control across the whole flow. Worker is called via `tool_use`, returns via `tool_result`, supervisor receives the result and decides the next move. The supervisor's context accumulates every worker's output; the supervisor is the only thing that knows the whole state.
- **Handoff-style**: supervisor *transfers control* to a worker mid-conversation. The worker takes over the conversation, runs its own loop, and either hands back or finishes. The supervisor's context shrinks; the worker's grows. Easier to express specialist personality; harder to trace because the conversation moves between agents.

For most production supervisor-worker systems the answer is tools-style — debuggability wins. The supervisor's trace is one continuous trajectory; the worker calls are inspectable events on that trajectory. Handoff-style requires multi-agent tracing infrastructure that this repo doesn't have today and probably shouldn't add unless the use case demands it.

#### The synthesis problem

The supervisor's final job — synthesizing the worker outputs into a coherent answer — is where this pattern most often fails. Two worker outputs that disagree ("worker A says the cause is churn; worker B says the cause is a campaign drop") force the supervisor to pick or merge. Naive merging averages contradictory answers and hides the disagreement. The production pattern (`09-coordination-failure-modes.md`) is to validate worker outputs against a schema before synthesis and surface conflicts rather than average them.

For this repo, the synthesis would happen at "the supervisor reads the diagnosis + reads the recommendations + writes a unified summary." That's the easy case — the diagnosis comes before the recommendations and there's no contradiction. A harder case would be "supervisor reads three parallel diagnostic agents, each testing a different hypothesis space" — then synthesis becomes "which hypothesis wins" with all the failure modes of multi-source merging.

### Move 3 — the principle

**Supervisor-worker earns its tax when the task is decomposable into specialties AND the decomposition isn't enumerable in code.** The "AND" is load-bearing. If the decomposition is enumerable (this repo: always monitor → diagnose → recommend), use deterministic code — no supervisor needed. If the decomposition is decomposable but the *which workers to run* varies per request, the supervisor's job to pick worker dispatch becomes worth a model call.

## Primary diagram

```
  Supervisor-worker (hypothetical for this repo)

  ┌─ /api/agent/route.ts ────────────────────────────────────────┐
  │                                                                │
  │  ┌─ SupervisorAgent.handleQuery(query) ──────────────────┐  │
  │  │                                                          │  │
  │  │  runAgentLoop:                                          │  │
  │  │    model: Sonnet (the supervisor's model)               │  │
  │  │    tools: [run_diagnostic, run_recommendation,           │  │
  │  │            run_monitoring, run_query]                    │  │
  │  │    system: SUPERVISOR_PROMPT (when to dispatch which     │  │
  │  │            worker; how to synthesize)                    │  │
  │  │                                                          │  │
  │  │  turn N: tool_use(run_diagnostic, {anomaly: ...})        │  │
  │  │                       │                                   │  │
  │  │                       ▼                                   │  │
  │  │  ┌─ DiagnosticAgent (worker) ─────────────────────────┐ │  │
  │  │  │   runs its own runAgentLoop (the existing one)      │ │  │
  │  │  │   returns Diagnosis                                 │ │  │
  │  │  └─────────────────────┬───────────────────────────────┘ │  │
  │  │                        │ Diagnosis                         │  │
  │  │                        ▼                                   │  │
  │  │  turn N+1: tool_use(run_recommendation, {diagnosis})     │  │
  │  │                       │                                   │  │
  │  │                       ▼                                   │  │
  │  │  (same shape — RecommendationAgent runs, returns recs)  │  │
  │  │                                                          │  │
  │  │  turn N+2: text only — supervisor synthesizes             │  │
  │  │  break — final answer combining diagnosis + recommendation│  │
  │  └─────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The supervisor-worker pattern in production agent systems usually picks Sonnet (or another mid-tier reasoning model) for the supervisor and a mix of Sonnet and Haiku for the workers based on per-worker complexity. The supervisor's cost is amortized across workers — one supervisor model call per dispatch decision, many cheap-or-expensive worker calls per dispatch. If you size it right, the supervisor's overhead is single-digit percent of total cost. If you size it wrong (Sonnet workers + Sonnet supervisor + over-frequent dispatch), the supervisor doubles or triples per-request cost.

The pattern's natural home is "task you can describe as a one-line user goal that decomposes into a handful of sub-tasks the supervisor picks at runtime." Research assistants, customer-support routing-and-resolution, multi-step code-edit agents. Anything where the user input is varied enough that you can't enumerate the dispatch in code.

This repo's domain has *narrow* user inputs (an anomaly card click, a free-form query, a manual investigation step). The dispatch is enumerable for all but the free-form query, and the free-form query already has the intent classifier (`01-reasoning-patterns/07-routing.md`). The supervisor's "pick which agent" job has no work to do.

## Interview defense

> **Q: Is this codebase supervisor-worker?**
>
> No. It looks like it from a distance — there's an orchestrator and four agents — but the orchestrator is deterministic TypeScript, not an LLM supervisor. The route handlers in `app/api/briefing/route.ts` and `app/api/agent/route.ts` write the dispatch order ("monitor before diagnose; diagnose before recommend") in plain code. A real supervisor would be an LLM agent whose tools were the worker agents; this repo's "supervisor" is a few lines of TypeScript. The distinction matters because supervisor-worker carries the 2-5x coordination tax that deterministic dispatch doesn't.

> **Q: When would you escalate to a real supervisor?**
>
> When the dispatch decision stops being enumerable in code. Today the orchestration is "always monitor, then always diagnose on click, then always recommend on click" — that's three `if`s. If the product grew "sometimes recommend without diagnosing; sometimes run a deep dive on a single segment instead of an investigation; sometimes synthesize across multiple anomalies" and the route handler's `if`s became a 30-line dispatch with overlapping conditions, that's the signal. A supervisor model handles that branching cleaner than nested code.

> **Q: Tools-style vs handoff-style — which would you pick?**
>
> Tools-style by default, for debuggability. The supervisor's `runAgentLoop` produces one continuous trajectory the StatusLog can render; every worker call is one `tool_call_start` / `_end` pair in the trace. Handoff-style fragments the trajectory across multiple agents' traces and forces multi-agent UI plumbing this repo doesn't have. The flexibility win of handoff-style (the worker can "stay in character" and own the conversation) isn't worth the trace complexity for an analytical-investigation domain where there's no character to maintain.

## See also

- → `01-when-not-to-go-multi-agent.md` — the gate that has to open before this earns its tax
- → `03-sequential-pipeline.md` — the structural alternative when dispatch is known in advance
- → `07-graph-orchestration.md` — supervisor-worker made explicit as a state machine
- → `08-shared-state-and-message-passing.md` — how the supervisor's worker outputs reach each other
- → `06-orchestration-system-design-templates/02-agentic-support-system.md` — the system design template where supervisor-worker is canonical
