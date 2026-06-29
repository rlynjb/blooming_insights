# Shared state and message passing

**Industry standard.** Two models for how agents communicate. **Partially exercised** in this codebase — message passing via typed handoffs, no shared blackboard.

## Zoom out, then zoom in

Sits at the orchestration layer as a choice point: do agents read/write a common state, or do they only see what the previous stage explicitly passed?

```
  Zoom out — where this concept lives

  ┌─ Orchestration layer ───────────────────────────┐
  │  ★ shared state OR message passing? ★           │ ← we are here
  │  (this repo: typed handoffs, message-passing)    │
  └──────────────────────────────────────────────────┘
```

This repo's choice (message-passing via typed handoffs) is exactly what the spec recommends as the production answer.

## Structure pass

Layers: the inter-agent communication primitive (shared store vs message) → the context each agent sees → the failure modes that follow from the choice.

**Axis traced — "what does the next agent see?":** in shared state, the union of everyone's context. In message passing, only what was explicitly handed forward.

**Seam:** the typed value at the handoff. In this repo, that's `Anomaly` (monitoring → diagnostic), `Diagnosis` (diagnostic → recommendation), `Recommendation[]` (recommendation → UI).

## How it works

### Move 1 — the mental model

You know the difference between global state and prop drilling in a React app. Global state is the shared blackboard — any component can read or write the context, simple to reason about until your context gets bloated. Prop drilling is message passing — each component sees only what its parent explicitly hands it, scoped and clean but you have to decide what to pass.

```
  Two communication models

  Shared state (blackboard):       Message passing:
  ┌──────────────────────┐        agent A ──msg──► agent B
  │   shared context     │        agent B ──msg──► agent C
  │  (all agents read     │        (each agent sees only
  │   and write here)     │         what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

### Move 2 — step by step

#### What this repo does — typed message passing

Open `lib/mcp/types.ts`. The three typed handoff interfaces are right there:

```ts
// lib/mcp/types.ts:83-92 (Anomaly — monitoring output)
export interface Anomaly {
  metric: string;
  scope: string[];
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;
  history?: number[];
  category?: CategoryId;
}

// lib/mcp/types.ts:95-104 (Diagnosis — diagnostic output)
export interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
  confidence?: 'high' | 'medium' | 'low';
  timeSeries?: { day: string; value: number }[];
}

// lib/mcp/types.ts:116-130 (Recommendation — recommendation output)
export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact;
  confidence: 'high' | 'medium' | 'low';
  // ... business-owner enrichments
}
```

Each handoff is one of these three values. The next agent's constructor takes exactly the value(s) it needs and nothing else. There's no shared store; there's no "agent B reads from a context object agent A wrote to."

The diagnostic agent (`DiagnosticAgent.investigate(anomaly, hooks)`) takes one `Anomaly`. The recommendation agent (`RecommendationAgent.propose(anomaly, diagnosis, hooks)`) takes the `Anomaly` again *plus* the `Diagnosis`. The route handler is the one that holds both values during the request and decides what to pass.

#### Why message passing is the right choice here

Three reasons:

1. **The hand-off is small and bounded.** A `Diagnosis` is a few hundred bytes; an `Anomaly` is less. Passing them through the URL (the `?diagnosis=` query param in step 3) works because they're small. A shared blackboard would carry the same data plus everyone else's context — more bytes, more noise.

2. **Each agent has a scoped context window.** The diagnostic agent's prompt is built around investigating ONE anomaly; it doesn't need to know about other anomalies the monitoring agent found, or the recommendations the recommendation agent will propose. Scoping its input to just the anomaly keeps its context tight.

3. **No agent needs to coordinate with another mid-run.** The agents run sequentially; there's no "agent A and agent B both look at the same state simultaneously" pattern that shared state would enable. Without that pattern, shared state is overhead.

#### The shared-state version — what it would look like

For comparison, a shared-state version would have a `runContext` object the agents all read/write:

```ts
// hypothetical shared-state version (not implemented)
interface RunContext {
  anomaly: Anomaly;
  diagnosis?: Diagnosis;
  recommendations: Recommendation[];
  // every agent reads/writes this object
}

const context: RunContext = { anomaly, recommendations: [] };
await monitoringAgent.scan(context);   // writes to context.anomaly (or context.anomalies[])
await diagnosticAgent.investigate(context);  // reads context.anomaly, writes context.diagnosis
await recommendationAgent.propose(context);  // reads both, writes context.recommendations
```

This is simpler to reason about — one object, one source of truth. The cost is that every agent sees everything, including stuff it doesn't need. For three agents with bounded inputs, that's manageable; for 8-12 agents with overlapping reads/writes, the shared context becomes a coordination subproblem (who's allowed to read what; what happens if two agents try to write the same key) AND the context bloat hurts model attention.

The lost-in-the-middle problem is the specific failure mode: when the shared context grows past the model's effective attention window (~30-50% of the nominal context length), the model starts ignoring middle content. For an 8-agent system with rich shared state, this fires fast. Message passing scopes each agent's context to its actual inputs, sidestepping the problem.

#### Multi-agent context routing — the production refinement

The production heuristic, even within "message passing" systems, is to pass *role-specific context* to each agent rather than the full prior history. The diagnostic agent gets the anomaly + workspace schema, not the monitoring agent's chain-of-thought. The recommendation agent gets the diagnosis + anomaly + workspace schema, not the diagnostic agent's tool-call evidence (unless that evidence is specifically referenced in the diagnosis).

This repo does this implicitly because the handoff types are small and don't carry trajectory data. The `Diagnosis` interface doesn't have a `producerTrajectory: ReasoningStep[]` field — it has the conclusion + evidence + hypotheses + customer count. The recommendation agent doesn't need to re-read the diagnostic's tool calls; it needs the diagnostic's *conclusions* about what was found.

This is `04-agent-infrastructure/01-context-engineering.md` applied at the multi-agent boundary. The same discipline (curate what fills the window) extends to "which agent sees what."

### Move 3 — the principle

**Message passing scales better than shared state once you have more than 2-3 agents with rich inputs.** Shared state is simpler for small topologies but bloats fast; message passing requires deciding what to pass but keeps each agent's context tight. The right answer is *almost always* message passing with typed handoffs, with shared state reserved for cases where multiple agents genuinely need to coordinate over the same evolving structure (rare in practice).

## Primary diagram

```
  Message passing in this repo's pipeline — typed handoffs, no shared store

  ┌─ /api/briefing route ─────────────────────────────────────────┐
  │   MonitoringAgent.scan(hooks, runnable)                        │
  │     ─► returns Anomaly[]                                        │
  │   ─► route emits 'insight' NDJSON events                        │
  │   ─► UI stashes selected Insight in sessionStorage              │
  └────────────────────────────────┬──────────────────────────────┘
                                   │ via client navigation + sessionStorage
                                   │ (the handoff carries just the typed Anomaly)
                                   ▼
  ┌─ /api/agent?step=diagnose route ──────────────────────────────┐
  │   resolveAnomaly(insightId, ?insight=) → Anomaly               │
  │   DiagnosticAgent.investigate(anomaly, hooks)                  │
  │     ─► sees: anomaly + workspace schema + tools                 │
  │     ─► does NOT see: monitoring agent's tool calls, other       │
  │        anomalies in the briefing                                │
  │     ─► returns Diagnosis                                         │
  │   ─► route emits 'diagnosis' NDJSON                              │
  │   ─► UI stashes Diagnosis in sessionStorage                      │
  └────────────────────────────────┬──────────────────────────────┘
                                   │ via client navigation + ?diagnosis=
                                   │ (the handoff carries just the typed values)
                                   ▼
  ┌─ /api/agent?step=recommend route ─────────────────────────────┐
  │   resolveAnomaly(insightId, ?insight=) → Anomaly               │
  │   parseDiagnosis(?diagnosis=) → Diagnosis                       │
  │   RecommendationAgent.propose(anomaly, diagnosis, hooks)       │
  │     ─► sees: anomaly + diagnosis + workspace schema + tools    │
  │     ─► does NOT see: diagnostic agent's tool calls,             │
  │        diagnostic agent's chain-of-thought                      │
  │     ─► returns Recommendation[]                                  │
  └────────────────────────────────────────────────────────────────┘

  No shared blackboard. Each agent's context is exactly the typed
  inputs it needs plus its own system prompt and allowed tools.
```

## Elaborate

The shared-state pattern (sometimes called "blackboard architecture") has academic AI roots and shows up in some agent frameworks (CrewAI's `Crew.context`, AutoGen's group-chat history) as the default. The simplicity is appealing for tutorials and demos; the bloat shows up in production when topology grows past ~3 agents.

The typed-handoff pattern this repo uses corresponds to what some agent frameworks call "agent-as-a-function" — each agent is a typed function (`(Anomaly) => Promise<Diagnosis>`) the orchestrator composes. The functional framing makes testing trivial (mock the inputs, assert the output) and forces the handoff contracts to be explicit (you can't accidentally read a sibling agent's context).

The Vercel AI SDK's "tools" pattern is a hybrid: tools have typed schemas (forcing input scoping) but share the underlying chat conversation across calls. Most "multi-agent" implementations in production are some version of this — typed contracts for the agent's surface, shared conversation history for the threading. This repo's split — typed handoffs *and* fresh conversation per agent — is the more aggressive scoping choice and pays off in tighter per-agent contexts.

## Interview defense

> **Q: How do the agents in this codebase communicate?**
>
> Typed message passing through the route handlers. Each agent class takes typed inputs (`Anomaly` for the diagnostic; `Anomaly + Diagnosis` for the recommendation) and produces a typed output the next stage consumes. There's no shared blackboard, no global context object. The orchestrator (route handler) is the only thing that holds all three values during one request; each agent sees just what it needs. The `Anomaly`, `Diagnosis`, and `Recommendation` interfaces in `lib/mcp/types.ts:83-130` are the contracts at the handoff seams.

> **Q: Why message passing instead of shared state?**
>
> Three reasons. Each agent has bounded inputs — the diagnostic agent doesn't need to see other anomalies the monitoring agent found, or the recommendations the next agent will write. Scoping its context to just the anomaly keeps the system prompt tight and the model's attention focused. The agents don't coordinate mid-run — they run sequentially with no shared writes, so the "blackboard concurrency" model has nothing to do here. And the handoff values are small (an `Anomaly` is hundreds of bytes), which means message passing has no cost penalty over shared state — both fit in a query param or a sessionStorage entry. The lost-in-the-middle problem hits shared-state topologies hard once they grow past 3-4 agents; message passing sidesteps it.

> **Q: What's the cost of getting message passing wrong?**
>
> The cost is an agent acting on missing context. If the recommendation agent didn't get the diagnosis (we forgot to pass it), the recommendations would be ungrounded — proposed actions with no causal link to the anomaly. The mitigation is exactly the typed interface: TypeScript enforces "you must pass a `Diagnosis` to `RecommendationAgent.propose`," so the route handler can't accidentally omit it. The compile-time check is the safety net for the "what to pass" decision.

## See also

- → `03-sequential-pipeline.md` — the pipeline these typed handoffs run inside
- → `09-coordination-failure-modes.md` — what goes wrong when message-passing decisions are buggy
- → `04-agent-infrastructure/01-context-engineering.md` — the same "curate what's in the window" discipline applied per-agent
