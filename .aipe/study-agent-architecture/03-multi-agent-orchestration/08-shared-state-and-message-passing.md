# Shared state and message passing

_Industry standard._

## Zoom out, then zoom in

How agents communicate. Two models: shared state (blackboard — everyone reads and writes one context) and message passing (each agent sees only what's explicitly passed). This repo uses *both*: the workspace schema is shared state (every agent gets it in its system prompt), and the Diagnosis is a message (handed from Stage A to Stage B).

```
  Zoom out — both models coexist in this repo

  ┌─ Shared state (blackboard) ─────────────────────────────────┐
  │  WorkspaceSchema — projectId, events, customer props        │
  │  schemaSummary() injected into every agent's system prompt  │
  │  every agent reads; no agent writes                         │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Message passing ───────────────────────────────────────────┐
  │  Diagnosis — handed from DiagnosticAgent → RecommendationAgent│
  │  Anomaly — handed from feed → both agents                   │
  │  Intent — handed from classifyIntent → QueryAgent           │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the two models split by *what changes and what doesn't*. Read-mostly reference data (workspace schema) is shared. Investigation-specific artifacts (Diagnosis, Recommendation) are passed. That's the production-grade split — shared state for the immutable, messages for the flow.

## Structure pass

**Layers:** shared context (read-mostly reference) · message channel (typed artifacts) · trace channel (observation).
**Axis:** *does this data change during the investigation, or is it stable across the run?*
**Seam:** the type contract on messages. `Diagnosis` is a typed shape — Stage B can consume it without knowing which Stage A produced it. That decoupling is the seam.

```
  Two models, one system

  ┌─ Shared (blackboard) ──────────────────────┐
  │  WorkspaceSchema                            │  ← read by all
  │  Session state (Map<sessionId, SessionFeed>)│
  └─────────────────────────────────────────────┘
              ▲                       ▲
              │ read                  │ read
  ┌───────────┴──────┐     ┌──────────┴────────┐
  │ DiagnosticAgent  │────►│ RecommendationAgent│  ← message
  │                  │ Diag│                    │    passing
  └──────────────────┘     └────────────────────┘
```

## How it works

### Move 1 — the mental model

You've written React apps with two shapes of data: Context (available to every component that reads it — theme, current user) and props (passed explicitly from parent to child — the row this component renders). Shared state is Context; message passing is props. The rule is the same: stable/read-only data goes in Context, per-flow data goes in props. Apply the same instinct to agent communication.

```
  Pattern: two-channel communication

  Channel 1 — shared (Context-like):
    WorkspaceSchema → every agent's system prompt

  Channel 2 — messages (props-like):
    Anomaly → DiagnosticAgent
    Diagnosis → RecommendationAgent
    Recommendation → UI
```

### Move 2 — the walkthrough

**Shared state — workspace schema.** `lib/agents/monitoring.ts:19-60` builds `schemaSummary(schema)` — a compact prompt-safe summary of the workspace (top 20 events with property counts, top 30 customer properties, catalog names). This summary gets injected into every agent's system prompt so the model knows what data is queryable.

```ts
// lib/agents/monitoring.ts:19-60 — the shared schema summary
export function schemaSummary(schema: WorkspaceSchema): string {
  // ... top 20 events, each with up to 10 properties
  // ... top 30 customer properties
  // ... catalog names
  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Top events (name, eventCount: properties):`,
    eventsText,
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}
```

Line-by-line:

- **The compact summary is not the full 112KB schema.** The full schema would blow the system-prompt budget and trigger lost-in-the-middle. Twenty events × ten properties is roughly 1-2KB — small enough to sit in cached prefix (`05-production-serving/04-cost-controls.md` covers the Anthropic ephemeral cache on system prompts).
- **Every agent reads the same summary.** DiagnosticAgent, RecommendationAgent, MonitoringAgent, QueryAgent — same summary function, same output. The model sees the same worldview across the whole investigation.
- **No agent writes to it.** The schema is fetched once per session bootstrap and pinned. That immutability is what makes it safe to share — no synchronization concerns, no stale-read risk.

**Message passing — Diagnosis handoff.** `app/api/agent/route.ts:266-297` is where the Diagnosis moves between agents. It's a typed value returned from Stage A, then passed as a positional argument to Stage B (see `03-sequential-pipeline.md` for the pipeline mechanics).

```ts
// route.ts — the message
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
send({ type: 'diagnosis', diagnosis });  // also streamed to UI

// route.ts — the receive
const recommendations = await recAgent.propose(inv, diagnosis!, { ...hooksFor('recommendation'), signal: req.signal });
```

Line-by-line:

- **`diagnosis` is `Diagnosis` (typed).** TypeScript enforces the contract. Stage B can't accidentally consume the wrong shape.
- **The message is streamed to the UI at the boundary.** `send({ type: 'diagnosis', diagnosis })` makes the message visible to a third party (the browser). That's structurally the difference between message passing and shared state — messages have a *transit* the observer can watch.
- **The message is also serializable to a URL.** Step 3 (`/investigate/[id]/recommend`) can receive the Diagnosis as a URL param, so a user navigating directly to the recommend page skips Stage A. That's the "URL as checkpoint" pattern (`07-graph-orchestration.md`).

**Session isolation — the shared state has a scope.** `lib/state/insights.ts:14` — `const state = new Map<string, SessionFeed>()` — keeps each user's data in a per-session sub-map. Without this, one user's briefing would leak into another user's feed on a warm Vercel instance. That's the load-bearing "shared but scoped" pattern — shared state is not the same as global state; it needs a scope key.

```
  Layers-and-hops — communication channels in one investigation

  ┌─ Session bootstrap ────────────────────────────────────────┐
  │  fetch workspace schema once → build schemaSummary          │
  └───────────────────────┬────────────────────────────────────┘
                          │ pinned in system prompt (shared)
                          ▼
  ┌─ Stage A: DiagnosticAgent ─────────────────────────────────┐
  │  reads: schema (shared) + anomaly (message)                │
  │  writes: Diagnosis (message)                               │
  └───────────────────────┬────────────────────────────────────┘
                          │ Diagnosis passed by supervisor
                          ▼
  ┌─ Stage B: RecommendationAgent ─────────────────────────────┐
  │  reads: schema (shared) + anomaly + Diagnosis (messages)   │
  │  writes: Recommendation[] (messages)                       │
  └────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Shared state for the immutable; messages for the flow. Every agent needs the workspace schema — sharing it once is right. Every investigation produces a Diagnosis for that specific anomaly — passing it as a typed message is right. Getting this wrong in either direction has a specific failure: sharing the Diagnosis (blackboard style) risks bleed between concurrent investigations; passing the schema as a message wastes tokens on every hop. The senior-grade split is naming *what changes and what doesn't* and picking the model that fits.

## Primary diagram

```
  Recap — the two channels of communication

  ┌─ Shared context (read-mostly) ─────────────────────┐
  │  WorkspaceSchema.summary → system prompt          │
  │  Session identity → auth + isolation              │
  │  Scope: session (per-user Map)                     │
  └────────────────────────────────────────────────────┘

  ┌─ Message channel (typed handoffs) ─────────────────┐
  │  Anomaly (feed → agents)                           │
  │  Diagnosis (DiagnosticAgent → RecommendationAgent) │
  │  Recommendation (RecommendationAgent → UI)         │
  │  Intent (classifyIntent → QueryAgent)              │
  │  Scope: one investigation                          │
  └────────────────────────────────────────────────────┘

  ┌─ Trace channel (observation) ──────────────────────┐
  │  NDJSON events (per-agent trace → UI)              │
  │  Read-only observation, not communication          │
  │  Scope: one request                                │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The design instinct here is straight from software engineering: prefer explicit interfaces over implicit shared state. Every artifact that flows between agents in blooming is a *typed message* (Anomaly, Diagnosis, Recommendation), not a mutation to a shared blackboard. The workspace schema is the exception, and it's exceptional for a reason: it's read-only reference data, not investigation state.

The message-passing discipline pays off during evals. `eval/report.eval.ts` grades a Diagnosis against a rubric — it can do so because Diagnosis is a serializable typed value that a grader can inspect independently. If diagnosis lived on a mutable blackboard, isolating "what did Stage A produce for this case" would require a snapshot dance.

The one place blooming has a *shared but scoped* pattern is session state — `SessionFeed` maps in `lib/state/insights.ts`. This is the multi-tenant version of shared state: shared within a session, isolated between sessions. Every long-running agent system in production needs this scope key or user data leaks. Blooming's warm-instance concurrency (a single Vercel process serving many users) makes the scope explicit; a single-user CLI could get away with global state.

## Interview defense

**Q: How do agents in this system communicate — shared state or messages?**
A: Both, split by what changes. Shared state for read-mostly reference data — the workspace schema summary is injected into every agent's system prompt, same worldview across the run. Message passing for investigation state — the Diagnosis is a typed value handed from `DiagnosticAgent` to `RecommendationAgent` via the supervisor, and the same message gets streamed to the UI as an NDJSON event. The rule I follow: if the data is immutable and every agent needs it, share it; if the data is per-flow and typed, pass it. Wrong direction on either has a specific failure — sharing per-flow data leaks between concurrent investigations, passing shared data wastes tokens per hop.

Diagram: the two-channel picture with WorkspaceSchema on one side and Diagnosis on the other.
Anchor: `lib/agents/monitoring.ts:19-60` (schema summary) + `app/api/agent/route.ts:266-297` (Diagnosis handoff).

**Q: What prevents concurrent investigations from bleeding into each other?**
A: Session-scoped shared state. `lib/state/insights.ts:14` keeps a `Map<sessionId, SessionFeed>` — each user's feed lives in its own sub-map, keyed by the session cookie. A single warm Vercel instance can serve multiple users concurrently, and without this scope key, one user's `putInsights` would clear another's feed mid-briefing. This is the multi-tenant version of shared state: shared within a session, isolated between them. The pattern generalizes — any long-running agent system in production needs a scope key, or user data leaks under concurrency.

Diagram: the session-scoped Map, with two concurrent users in isolated buckets.
Anchor: `lib/state/insights.ts:14-23`.

## See also

- `03-sequential-pipeline.md` — the Diagnosis-as-message pattern in flow.
- `04-agent-infrastructure/01-context-engineering.md` — the discipline that decides what goes in the system prompt (the shared state).
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the tier of memory this shared state lives at (working, in-context).
- `09-coordination-failure-modes.md` — context bloat when shared state grows unchecked.
