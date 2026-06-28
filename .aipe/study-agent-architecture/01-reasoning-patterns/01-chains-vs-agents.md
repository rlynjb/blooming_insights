# Chains vs agents

*Industry name: chains vs agents — Industry standard. The entry-point distinction.*

## Zoom out — where this concept lives

The boundary lives at the route handler. Above it: a TypeScript pipeline that *you* wrote. Below it: four LLM loops that *write their own steps at runtime*. Both shapes exist in this repo. They compose.

```
  Where the boundary sits in blooming insights

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  app/page.tsx     app/investigate/[id]/page.tsx          │
  └─────────────────────────┬───────────────────────────────┘
                            │  GET /api/agent?step=diagnose
  ┌─ Service layer (THE CHAIN) ─────────────────────────────┐
  │  app/api/agent/route.ts                                  │
  │   bootstrap → classifyIntent → ★ pick agent ★ → stream  │ ← chain
  │   ^ engineer wrote these steps; the LLM doesn't pick    │
  └─────────────────────────┬───────────────────────────────┘
                            │  instantiates ONE agent
  ┌─ Agent layer (THE AGENTS) ──────────────────────────────┐
  │  MonitoringAgent | DiagnosticAgent | RecommendationAgent│
  │   ★ here the model picks its next move ★                │ ← agent
  │   each is one runAgentLoop() call                        │
  └──────────────────────────────────────────────────────────┘
```

The interesting thing: **this repo is hybrid**. The outer shape is a chain (the route handler), and inside each chain step lives an agent (one `runAgentLoop`). The product workflow is fixed (what changed → why → what to do), so the chain knows the order; *inside* each step the model has to decide which EQL queries to run, so the agent picks.

## Structure pass — one axis, two layers

Hold one question constant and trace it down the stack: **who decides what happens next?**

```
  One question, held down two layers

  "who decides the next step?"

  ┌─ outer: app/api/agent/route.ts ───────────┐
  │  CODE decides (the URL `?step=` and the   │  → engineer-written
  │  conditional `if (step === 'recommend')`)  │
  └──────────────┬─────────────────────────────┘
                 │  delegates to one agent class
  ┌─ inner: MonitoringAgent.scan() ───────────┐
  │  MODEL decides (the model picks each tool │  → LLM-written
  │  call inside runAgentLoop's while loop)    │
  └────────────────────────────────────────────┘

  the answer flips across the route↔agent seam
```

That flip is the seam. Above it: deterministic dispatch. Below it: autonomous loop. Every chains-vs-agents discussion is a re-derivation of where you decided to put that flip.

## How it works

### Move 1 — the mental model

A chain is a `.then()` chain you wrote. An agent is a `while` loop the model drives. You already know `.then()` chains — every `fetch().then(json).then(render)` is one; you wrote the sequence, the runtime just executes it. An agent flips that: you give the model tools and a goal, and the model writes the sequence at runtime.

```
  Two shapes, side by side

  CHAIN (engineer wrote the sequence):       AGENT (model writes the sequence):
  ┌───────┐ ┌───────┐ ┌───────┐               ┌─────────────────────────────────┐
  │ step1 │►│ step2 │►│ step3 │               │  while not done:                │
  └───────┘ └───────┘ └───────┘               │    action = step(state)         │ ← model picks
       │        │        │                    │    if final → return            │
       ▼        ▼        ▼                    │    result = execute(action)     │
   (LLM fills  (LLM     (LLM                  │    state = accumulate(result)   │
    each slot, fills,    fills,               │  budget exit if too long        │
    but doesn't pick     doesn't               └─────────────────────────────────┘
    what's next)         pick next)            ^ the model chose each action
```

### Move 2 — the parts that actually exist in this repo

**The chain part — `app/api/agent/route.ts`**

The route is the chain. It runs steps in a fixed order, picked by the URL. The model never decides which agent runs next; the URL does. Here's the actual control flow from the file:

```typescript
// app/api/agent/route.ts:267-297 (the orchestration core)
// STEP 2 (diagnose) or the combined run: run the diagnostic agent.
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) throw new Error('no diagnosis was handed over...');
} else {
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  send({ type: 'diagnosis', diagnosis });
}

// STEP 3 (recommend) or the combined run: run the recommendation agent.
if (step !== 'diagnose') {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recommendations = await recAgent.propose(inv, diagnosis!, {...});
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

What this is: a TypeScript conditional that runs DiagnosticAgent or RecommendationAgent or both based on a URL parameter. The `if (step === 'recommend')` is the orchestrator. It's a chain because *you wrote the if-statement* — the model never sees the URL.

**The agent part — `lib/agents/diagnostic.ts`**

Once the route dispatches into `DiagnosticAgent.investigate(...)`, control flips. From here on, the model picks every move:

```typescript
// lib/agents/diagnostic.ts:35-44 (the agent boundary)
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', this.sessionId),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });

  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

This one call runs a full ReAct loop — up to 8 turns, up to 6 tool calls, the model picking each EQL query, hypothesizing, falsifying. The route handler waits for it to finish and then maybe runs the next agent. The flip is at the `await`: above it, deterministic; below it, autonomous.

### Move 2.5 — the boundary the legacy code makes obvious

The legacy file at `lib/agents/base-legacy.ts:86-222` holds Blooming's hand-rolled `runAgentLoop`. It's preserved unused — the active path never calls it. It exists because seeing both implementations side-by-side makes the chain↔agent flip concrete: the route is a `for` loop over URL params; the agent loop is a `for` loop over LLM turns. *Same control-flow primitive, different decider.*

### Move 3 — the principle

The chain↔agent boundary is where you give control to the model. Put it too high (the LLM picks which API route to call) and you've handed away orchestration; put it too low (the LLM only fills in template slots) and you've built a workflow that just happens to use an LLM. The right place is where the steps *genuinely depend on what the model finds*. In this repo: the product workflow (briefing → diagnose → recommend) is fixed, so it's a chain; the EQL queries inside each step depend on what the data shows, so each step is an agent.

## Primary diagram

The full picture: the chain↔agent flip happens at the `route.ts` ↔ `lib/agents/*` seam, and inside each agent the kernel from `02-agent-loop-skeleton.md` runs.

```
  Chains and agents — composed, in this repo

  ┌─ CHAIN (app/api/agent/route.ts) ─ engineer writes ──────────────┐
  │                                                                  │
  │   req → bootstrap → listTools → route on ?step → ★ agent ★ → done│
  │                                                  │                │
  │                                                  ▼                │
  │   ┌─ AGENT (lib/agents/diagnostic.ts) ─ model writes ─────────┐ │
  │   │  while not done {                                          │ │
  │   │    step  ← model picks next EQL query                      │ │
  │   │    if final → return diagnosis JSON                        │ │
  │   │    result ← dataSource.callTool(...)                       │ │
  │   │    accumulate                                              │ │
  │   │    if maxToolCalls=6 spent → forced-final synthesis turn   │ │
  │   │  }                                                          │ │
  │   └────────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │  the route still has more chain steps after the agent returns:   │
  │  send `diagnosis` event → maybe run recommendation agent → done  │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The chains-vs-agents distinction crystallized around 2023 with LangChain's `Chain` vs `AgentExecutor` split — chains were predefined sequences, agents were ReAct-style loops with tool routers. The naming has drifted (LangChain itself moved toward LangGraph's state-machine framing), but the underlying boundary is the same: *who's the decider*.

The decision rule is operational. Use a chain when:
- The steps are known in advance (this repo's product workflow)
- Latency budget is tight (no exploration overhead)
- The cost has to be predictable (no variable iteration count)

Use an agent when:
- The path depends on what the model finds (this repo's per-step EQL exploration)
- The user's input can't be anticipated (this repo's QueryAgent for free-form Q&A)
- The quality ceiling of a fixed-step pipeline is lower than the variable-cost agent

The hybrid pattern this repo uses — chain outside, agent inside — is the common production answer. It bounds the unpredictability to the inner layer where you actually need it.

## Interview defense

**Q: "Is your system a chain or an agent?"**

A: Both, layered. The outer shape is a chain — `app/api/agent/route.ts` decides which agent runs based on the URL `?step=` parameter, not the model. Inside each chain step lives an agent — `runAgentLoop` from `@aptkit/core@0.3.0` driving up to 8 turns with up to 6 tool calls. The product workflow is fixed (what changed → why → what to do) so the orchestration is deterministic, but each step has to choose EQL queries based on the data, so each step is autonomous.

The diagram I'd sketch:

```
  ┌─ route (chain) ─┐
  │  if (step===X)  │  ← engineer wrote this
  │    → agent      │
  └───────┬─────────┘
          ▼
    ┌─ agent ─┐      ← model writes the sequence
    │  while  │
    └─────────┘
```

Anchor: "the flip happens at the `await diagAgent.investigate(...)` in `route.ts` line 282 — above that line code decides; below it the model does."

**Q: "Why not make the route itself an LLM supervisor?"**

A: Because the steps are known. The product is briefing → diagnose → recommend; there's no decision for a supervisor to make. Paying ~2-5x coordination tokens for an LLM to re-derive "run the diagnostic agent next" every request would be waste. We bought a chain's predictability where we can; we spent agents' flexibility where the data requires it.

## See also

- [`02-agent-loop-skeleton.md`](./02-agent-loop-skeleton.md) — the kernel inside the agent half
- [`07-routing.md`](./07-routing.md) — how the intent classifier picks the framing without picking the agent
- [`../03-multi-agent-orchestration/03-sequential-pipeline.md`](../03-multi-agent-orchestration/03-sequential-pipeline.md) — the chain extended across multiple agents
- ReAct mechanics: ai-engineering's `04-agents-and-tool-use/01-agents-vs-chains.md` (if generated)
