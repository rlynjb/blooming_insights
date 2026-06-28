# Shared state and message passing

*Industry name: shared state / blackboard / message passing — Industry standard.*

How agents communicate. **This repo uses message passing**, forced by the architecture — Vercel's ephemeral serverless instances make a shared blackboard impractical. The diagnostic agent's output is the recommendation agent's input, passed as a plain JSON URL param.

## Zoom out — where this concept lives

The choice between shared state and message passing is made at the topology level — it shapes how agents are wired together. In this repo it's made at the route layer: each agent gets the *exact* data it needs, via function args (in-process) or URL params (cross-request).

```
  Where the choice lives in blooming insights

  ┌─ Service layer ─────────────────────────────────────────┐
  │  app/api/agent/route.ts                                  │
  │   chooses HOW each agent receives state                  │ ← we are here
  │    - in-process handoff: function arg                    │
  │    - cross-request handoff: URL param + sessionStorage   │
  │   NEVER a shared blackboard                              │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what does each agent see?**

```
  Shared state (blackboard):              Message passing:
  ────────────────────────────            ──────────────────────
  every agent reads/writes the            each agent sees only what
  same context blob                       was passed to it
                                          (function arg, URL param)
  pro: simple to reason about              pro: focused context;
       (one place for state)                    cheaper per agent;
                                               no lost-in-the-middle
                                               from N-agent bloat
  con: context bloat as agents             con: requires deciding
       accumulate                                what to pass; bug
                                                there = missing info
  con: lost-in-the-middle as the           pro: forced minimalism;
       blob grows                                each agent stays narrow
```

## How it works

### Move 1 — the mental model

You know props vs context in React — props is message passing (each component receives exactly what it needs); context is shared state (any descendant can read the value). Same shape, agent edition. Message passing keeps each agent's context narrow; shared blackboard puts everything in front of every agent.

```
  Two models of agent communication

  Shared state (blackboard):                 Message passing:
  ┌──────────────────────┐                  agent A ──msg──► agent B
  │   shared context     │                  agent B ──msg──► agent C
  │  (all agents read     │                  (each agent sees only
  │   and write here)     │                   what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

### Move 2 — how this repo's message passing works, in two channels

**Channel 1: in-process (function args).**

When the route runs both diagnostic and recommendation in one request (the capture-only combined run), the diagnosis is passed as a function argument:

```typescript
// app/api/agent/route.ts (combined run flow, paraphrased)
diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
// ...
const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
```

`diagnosis` is a plain `Diagnosis` object; `recAgent.propose` receives it as its second argument. No global state, no blackboard. The RecommendationAgent's prompt only sees what the upstream produced.

**Channel 2: cross-request (URL param + browser sessionStorage).**

When the user reviews the diagnosis between step 2 and step 3, the diagnosis has to survive an HTTP round-trip. Vercel serverless instances are ephemeral — the instance handling step 2 might not handle step 3. So the diagnosis is:

1. Returned to the browser as a `diagnosis` NDJSON event
2. Stashed by `lib/hooks/useInvestigation.ts` in `sessionStorage`
3. Passed back to the server as a `?diagnosis=...` URL param when the user navigates to step 3
4. Parsed by `parseDiagnosis()` in the route handler

```typescript
// app/api/agent/route.ts:84-94 — receive the diagnosis on the way back in
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// app/api/agent/route.ts:269-272 — gate on it
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) throw new Error('no diagnosis was handed over — open the diagnosis step first');
}
```

The architectural pressure this creates: **the diagnosis has to be small enough to fit in a URL** (browsers and Vercel both have URL length limits). That's a real constraint that shaped the `Diagnosis` interface in `lib/mcp/types.ts` — conclusion is a string, evidence is a string array (not the full tool result), hypotheses are short reasoning strings. The architectural pressure produced a discipline.

### Move 2.5 — why no shared blackboard, even when in-process

Even within a single combined-run request (where in-process shared state would be technically possible), the route handler still uses message passing. Why?

- **Symmetry with the cross-request path.** The cross-request path has to be message-passing (no shared memory); the in-process path matches it so the agents have the same input shape in both cases. Less code, fewer surprises.
- **Forced minimalism.** Each agent's prompt is narrower because it only sees what it needs. RecommendationAgent doesn't get the raw monitoring trace; it gets the digested Diagnosis. Smaller prompt = cheaper, less lost-in-the-middle.
- **Test fakes are easier.** Each agent's input is a function arg, not "the current state of the blackboard." Mocking is straightforward — pass a fixture object.

### Move 3 — the principle

Shared state is simple to reason about but every agent sees everything, so context bloats with the number of agents (and the lost-in-the-middle problem scales with it). Message passing scopes each agent's context to what it needs (cheaper, less noise) but requires deciding what to pass — and a bug there means an agent acts on missing information. The production answer is **multi-agent context routing**: pass role-specific context to each agent, not a shared blob. It's a direct application of context engineering (`../04-agent-infrastructure/01-context-engineering.md`).

For systems where the platform forces ephemeral state (serverless, edge), message passing isn't even a choice — it's mandated. This repo turned that mandate into a discipline.

## Primary diagram

The two communication channels in this repo, with the data they carry:

```
  Message passing in blooming insights — two channels, one discipline

  Channel 1: in-process (capture combined run)
  ────────────────────────────────────────────
  ┌─────────────────────────────────────────────────────────────┐
  │ within ONE request:                                          │
  │   diag = await diagAgent.investigate(anomaly)               │
  │     diag : Diagnosis    ← plain JS object, function arg     │
  │   recs = await recAgent.propose(anomaly, diag)              │
  │     recs : Recommendation[]                                  │
  └─────────────────────────────────────────────────────────────┘

  Channel 2: cross-request (production split-step)
  ────────────────────────────────────────────────
  ┌─────────────────────────────────────────────────────────────┐
  │ step 2 response:                                             │
  │   { type: 'diagnosis', diagnosis: { conclusion, evidence, …}}│
  │           │                                                   │
  │           ▼ useInvestigation.ts → sessionStorage             │
  │   browser holds the diagnosis                                │
  │           │                                                   │
  │           ▼ user clicks "see recommendations →"              │
  │   GET /api/agent?step=recommend&diagnosis={JSON.stringify(d)}│
  │           │                                                   │
  │           ▼ route.ts: parseDiagnosis(diagnosisParam)         │
  │   recAgent.propose(anomaly, parsed diagnosis)                │
  └─────────────────────────────────────────────────────────────┘

  Both channels pass the SAME shape (Diagnosis). The architecture
  enforces it: cross-request requires serializable; in-process matches
  for symmetry.
```

## Elaborate

The shared-state-vs-message-passing question is older than agents — it's the same axis distributed-systems engineers have argued over for 40 years (shared memory vs message-passing concurrency models, Actor vs procedure-call). The agent-architecture wisdom is the same one those debates landed on: shared state is simpler in the small case and dangerous in the large case; message passing is more code in the small case and more robust in the large case.

For LLM agents specifically there's a second consideration: **context bloat**. A shared blackboard means every agent sees the cumulative state, which means every agent's prompt grows with every other agent's output. By 3-4 agents the context is dominated by other agents' chatter, lost-in-the-middle kicks in, and the model's attention on the actual task degrades. Message passing keeps each agent's prompt focused on its specific input.

The production-scarred pattern that emerged: even in frameworks that support shared state (LangGraph's State), the discipline is to pass role-specific *slices* of the shared state into each node — not the whole blob. That's message passing wearing shared-state's clothes. This repo just skips the costume and uses real message passing directly.

## Interview defense

**Q: "How do your agents share state?"**

A: They don't — they pass messages. Each agent's input is the previous agent's output, handed over as a plain JSON object. In the combined-run flow (capture only) it's a function argument; in the production split-step flow it's a URL query param round-tripped through the browser's sessionStorage. Both paths use the same `Diagnosis` shape, so the agents have the same input contract regardless of how the data got there.

The architectural pressure is interesting: Vercel's ephemeral serverless instances FORCE message passing — there's no shared memory between requests. So the cross-request path had to be serializable, which means the `Diagnosis` shape had to be small enough to fit in a URL. That pressure became a discipline: every agent's input is small and explicit. No blackboard, no context bloat from agents leaking into each other's prompts.

Diagram I'd sketch:

```
  ┌──────────┐  Diagnosis  ┌──────────┐
  │ DiagAgt  │ ──────────► │ RecAgt   │
  └──────────┘             └──────────┘
       ▲                        ▲
       │                        │
  in-process: function arg      │
  cross-request: URL param + sessionStorage

  NEVER a shared blackboard. The diagnosis is small enough to URL-encode.
```

Anchor: "the cross-request handoff at `route.ts:269` is the load-bearing constraint. Diagnosis has to be JSON-serializable and URL-fittable. That pressure shaped the type definition."

**Q: "Why message passing and not a blackboard, even in-process?"**

A: Symmetry with the cross-request path (less code, fewer surprises), forced minimalism (each agent's prompt is narrower, cheaper, less lost-in-the-middle), and testability (each agent's input is a function arg, not "the current state of some shared object" — fixtures are trivial). The blackboard pattern is more flexible but invites context bloat — by 3-4 agents the shared context is dominated by other agents' chatter. Message passing keeps each agent's prompt focused.

## See also

- [`03-sequential-pipeline.md`](./03-sequential-pipeline.md) — the sequencing that uses this message-passing
- [`../04-agent-infrastructure/01-context-engineering.md`](../04-agent-infrastructure/01-context-engineering.md) — what "what to pass" means in detail
- [`07-graph-orchestration.md`](./07-graph-orchestration.md) — the topology where blackboards are common
- [`09-coordination-failure-modes.md`](./09-coordination-failure-modes.md) — context bloat is one of the failures message-passing prevents
