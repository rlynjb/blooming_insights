# Chains vs agents — the boundary

*Industry names: workflow / chain vs autonomous agent · Language-agnostic*

## Zoom out — where this concept lives

```
  Zoom out — reasoning patterns sit inside "the worker"

  ┌─ UI layer ────────────────────────────────────┐
  │  useInvestigation streams NDJSON               │
  └───────────────────────┬───────────────────────┘
                          │
  ┌─ Route (supervisor) ──▼───────────────────────┐
  │  app/api/agent/route.ts — CODE routes         │
  └───────────────────────┬───────────────────────┘
                          │ constructs worker
  ┌─ Worker (agent) ──────▼───────────────────────┐
  │  ★ CHAIN vs AGENT — is there a loop? ★        │ ← we are here
  │  DiagnosticAgent runs an autonomous loop      │
  └───────────────────────┬───────────────────────┘
                          │ tool calls
  ┌─ Provider ────────────▼───────────────────────┐
  │  Bloomreach MCP (or other preset)             │
  └───────────────────────────────────────────────┘
```

## Zoom in

Two ways to organize LLM work. A **chain** is a set of steps you wrote down: the LLM fills in each slot, you decide what comes next. An **agent** is a loop where the LLM picks the next step at runtime. The question is who owns control flow.

## Structure pass

Layers: **the route** (outer, code) — **the worker** (inner, LLM or LLM-loop) — **the tool** (innermost, deterministic).

Axis to hold constant: **who decides control flow?**

```
  One question, held down the layers — chain vs agent

  "who decides what happens next?"  trace it downward

  ┌───────────────────────────────────────────┐
  │ route.ts sequences step 2 → step 3        │  → CODE decides
  └───────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ inside step 2: DiagnosticAgent          │  → agent path: LLM decides
      │  (chain path: engineer's steps decide)  │  → chain path: CODE decides
      └─────────────────────────────────────────┘
          ┌───────────────────────────────────┐
          │ innermost: MCP tool call          │  → tool runs (deterministic)
          └───────────────────────────────────┘
```

The seam this repo carries: **the outer layer is a chain of stages** (monitor → diagnose → recommend, written in the route), **the inner layer is an agent per stage** (each is a ReAct loop). Both patterns coexist. That's the whole trick — you don't pick one for the whole system; you pick per layer.

## How it works

### Move 1 — the shape

You've written a `.then()` chain of functions before: `parseInput().then(validate).then(transform).then(save)`. Each function fills a slot; the pipeline decides the order. That's a chain.

Now imagine one of those functions is instead a `while` loop that asks "what next?" every turn and only exits when it says "done." Same pipeline outside, autonomous decision inside. That's the boundary.

```
  Two structural shapes

  CHAIN — engineer wrote the steps
    Input ─► Step 1 ─► Step 2 ─► Step 3 ─► Output
             (LLM fills each slot; doesn't pick what comes next)

  AGENT — model picks the steps at runtime
    ┌────────────────────────────────────────┐
    │              agent loop                 │
    │  ┌────────┐                             │
    │  │ reason │ ← model chooses next action │
    │  └───┬────┘                             │
    │      ▼                                  │
    │  ┌────────┐                             │
    │  │  act   │ ← tool call                 │
    │  └───┬────┘                             │
    │      ▼                                  │
    │  ┌────────┐                             │
    │  │observe │ ← read result               │
    │  └───┬────┘                             │
    │      └─── loop or stop                  │
    └────────────────────────────────────────┘
```

### Move 2 — walk each side, then find both in this repo

**The chain half of this repo.** Open `app/api/agent/route.ts`. The route reads `?step=diagnose|recommend` and routes accordingly:

```ts
// app/api/agent/route.ts:285 (chain shape — steps are code)
if (step === 'diagnose' || !step) {
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  const diagnosis = await diagAgent.investigate(anomaly, hooks);
  send({ type: 'diagnosis', diagnosis });
}
if (step === 'recommend' || !step) {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recs = await recAgent.propose(anomaly, diagnosis, hooks);
}
```

Nothing here is autonomous. The engineer wrote `if step === diagnose`. If you wanted "diagnose then maybe re-monitor," you'd add another `if`. That's a workflow — a chain of stages with well-known transitions.

**The agent half of this repo.** Open `lib/agents/diagnostic.ts`. Inside `investigate()`, `AptKitDiagnosticInvestigationAgent` runs a ReAct loop. Each iteration:

```
  What happens inside investigate()

  turn 1:  model reads anomaly + schema
           → picks execute_analytics_eql to test hypothesis A
           → observes result

  turn 2:  model reads result
           → picks execute_analytics_eql to test hypothesis B
           → observes result

  turn 3:  model has enough evidence
           → emits final Diagnosis (JSON)
           → loop exits
```

Nothing in the codebase said "run hypothesis A then B." The model chose. If the workspace is different tomorrow, the model chooses a different sequence. That's an agent.

**The decision rule.** Use a chain when you know the steps in advance. Use an agent when the steps depend on what the model finds. This repo does both — three chain stages outside, one agent per stage inside.

**The cost of picking wrong.** Reaching for an agent when a chain would do costs: variable step count (unpredictable latency), variable cost (unpredictable spend), harder debugging (you now debug decisions the model made, not code you wrote). Reaching for a chain when an agent is needed costs quality — you'd have to enumerate every possible investigation path in code and pick one, and you'd hit the ones you didn't enumerate.

### Move 3 — the principle

Chains and agents are not two products — they are two ways of allocating control. Every non-trivial LLM system nests them: an agent inside a workflow stage, a workflow inside an agent's plan, agents calling agents. The reader-grade move is to pick the boundary per layer, not per system.

## Primary diagram

```
  Chains vs agents — the boundary in this repo

  ┌─ CHAIN (route decides) ───────────────────────────────────┐
  │                                                            │
  │  Step 1 monitor  ─►  Step 2 diagnose  ─►  Step 3 recommend │
  │  (briefing)          (agent inside)       (agent inside)   │
  │                                                            │
  └────────────────────────┬───────────────────────────────────┘
                           │ inside each stage
                           ▼
  ┌─ AGENT (model decides) ────────────────────────────────────┐
  │                                                            │
  │        ┌───► reason ───► act ───► observe ────┐            │
  │        └──────────────────────────────────────┘            │
  │                          │                                 │
  │                          ▼ done                            │
  │                     final output                           │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The vocabulary is settling: LangChain calls the chain half "runnables" (pipe-style composition) and the agent half "agents"; LlamaIndex calls them "query pipelines" vs "agents"; the underlying distinction is the same across frameworks. The name "agent" comes from RL/AI research where an agent is "an entity that perceives and acts autonomously in an environment" — the LLM playing that role is a recent stretch of the term, and it's why some prefer the more precise "tool-using LLM" or "reasoning loop."

The tradeoff isn't chain vs agent as an eitheror. Real production systems are *nested*: an outer workflow of well-known stages (monitor → diagnose → recommend), each stage an agent inside. This repo is that shape. Anthropic's "Building Effective Agents" essay (Dec 2024) codifies the same layering — start with prompts, escalate to workflows, only reach for agent loops when the task is genuinely open-ended.

## Interview defense

**Q: Is your system an agent or a workflow?**

Both — nested. Outer layer is a chain of three stages written into the route handler (`monitor → diagnose → recommend`); each stage is an agent (a ReAct loop) inside. That layering means I get predictable latency at the top (three stages, in that order) and adaptive behavior at the bottom (each stage picks its own tools based on what it finds).

*Anchor visual:* the chain-with-agents-inside diagram above.

**Q: When would you make the whole thing an agent?**

If the three-stage journey stopped being reliable — e.g., if some anomalies needed diagnose → monitor-again → diagnose loops. Right now the sequence is stable, so a supervisor LLM to pick it would add cost with no quality gain. That's the load-bearing rule: the escalation to autonomy is warranted only when specific failure modes prove the current control flow can't fix them.

## See also

- **`02-agent-loop-skeleton.md`** — the kernel every autonomous loop instantiates (the four load-bearing parts).
- **`03-react.md`** — the specific baseline this repo picked, and where it sits in the reasoning family.
- **`.aipe/study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`** — mechanics walkthrough.
