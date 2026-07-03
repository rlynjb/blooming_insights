# Chains vs agents (the boundary)

_Industry standard._

## Zoom out, then zoom in

Every LLM-integration decision starts here. Where does the *engineer* write the control flow, and where does the *model* write it?

```
  Zoom out — where the boundary sits in this repo

  ┌─ UI ──────────────────────────────────────────────────────┐
  │  feed · investigate/[id] · investigate/[id]/recommend      │
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Service (route.ts) ────────▼─────────────────────────────┐
  │  ★ THE OUTER LAYER IS A CHAIN ★                           │
  │  supervisor is TypeScript code: classifyIntent            │
  │  → route to worker → sequential diagnose → recommend      │
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Worker agents ─────────────▼─────────────────────────────┐
  │  ★ THE INNER LOOP IS AN AGENT ★                           │
  │  AptKit runAgentLoop: model picks the next tool per turn  │
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Data source ───────────────▼─────────────────────────────┐
  │  BloomreachDataSource / SyntheticDataSource               │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: this file is about the boundary itself. The rest of Section A lives *inside* the agent side of that boundary. Section C's supervisor-worker file lives at the *seam* itself — a code-written supervisor coordinating agent-shaped workers.

## Structure pass

**Layers:** outer pipeline (code) → inner loop (agent) → tool (deterministic).
**Axis to trace:** *who decides control flow?*
**Seams:** the axis flips at every layer boundary.

```
  Trace one question down: "who decides control flow?"

  ┌────────────────────────────────┐
  │ outer: route.ts                │  → CODE decides
  │   diagnose then recommend       │    (written sequence)
  └────────────────────────────────┘
      ┌──────────────────────────────┐
      │ inner: AptKit runAgentLoop   │  → LLM decides
      │   pick next tool per turn    │    (autonomous loop)
      └──────────────────────────────┘
          ┌────────────────────────────┐
          │ tool: execute_analytics_eql│  → TOOL runs
          │   deterministic query      │    (no choice)
          └────────────────────────────┘

  Answer flips at each altitude — that contrast IS the lesson.
```

The seams that matter: `route.ts` → `DiagnosticAgent` (code hands to loop), and `runAgentLoop` → `dataSource.callTool` (loop hands to tool).

## How it works

### Move 1 — the mental model

You've written a `.then()` chain of async functions before — `fetch(url).then(json).then(render)`. That's a chain: *you* wrote the sequence; each step just fills a slot. Now imagine one of those steps is a `while` loop where the *body* calls the model, and the model returns which function to call next. That's an agent.

```
  Pattern: chain vs agent

  Chain:                          Agent:
  ┌────────┐  ┌────────┐          ┌───────────────────────┐
  │ step 1 │→ │ step 2 │→ output  │  while not done:      │
  │  LLM   │  │  LLM   │          │    action = LLM(state)│
  └────────┘  └────────┘          │    if final: return    │
   engineer picks order            │    result = execute()  │
                                   │    state.append(result)│
                                   └───────────────────────┘
                                   model picks each action
```

### Move 2 — the walkthrough

**The chain half — `app/api/agent/route.ts`.** The outer sequence is written by hand. You can point at the exact lines that decide the order:

```ts
// app/api/agent/route.ts:230
const leadAgent: AgentName =
  q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';
// app/api/agent/route.ts:266-297 (paraphrased)
if (step === 'recommend') { diagnosis = parseDiagnosis(diagnosisParam); }
else { diagnosis = await diagAgent.investigate(inv, ...); }
if (step !== 'diagnose') {
  const recommendations = await recAgent.propose(inv, diagnosis!, ...);
}
```

Line-by-line: the branch chooses which agent to construct; the sequence "diagnose, then maybe recommend" is a TypeScript `if`, not a router LLM. If diagnostic fails, recommend never runs — the chain shape *enforces* that ordering. This is the outer supervisor's whole trick: predictable order at zero token cost.

**The agent half — `lib/agents/diagnostic.ts` → AptKit's `runAgentLoop`.** Once code hands off to `agent.investigate(anomaly)`, control transfers to the loop. See `node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js:25-105`:

```js
for (let turn = 0; turn < maxTurns; turn += 1) {
  const response = await model.complete({...});
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }
  for (const toolUse of toolUses) {
    const { result } = await tools.callTool(toolUse.name, toolUse.input, ...);
    // append tool_result to messages
  }
}
```

Line-by-line: the `for` loops up to `maxTurns=8` (bounded). The model returns either text (done — break) or `tool_use` blocks (call the tool, feed the result back, loop). *The model picks the tool every iteration.* The engineer wrote the loop; the model wrote the sequence of steps inside it.

**The seam.** `route.ts:280-283` is where the code side ends and the agent side begins:

```ts
const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
```

Before `await`: code control. After: agent control. The `await` hides ~50s of ReAct-loop iterations picking EQL queries.

### Move 3 — the principle

Use a chain when you know the steps in advance. Use an agent when the steps depend on what the model finds. This repo picks both, at the right altitudes: the flow diagnose→recommend is knowable (it's the product), so it's a chain. Which EQL queries to run to explain a metric change is *not* knowable (it's what the analyst discovers), so it's an agent. **Never one for the sake of consistency** — pick per axis.

## Primary diagram

```
  Recap — the boundary in this repo

  ┌─ /api/agent (route.ts) ────────────────────────────────────┐
  │  classifyIntent  →  branch  →  diagnose  →  recommend      │
  │  ─────── code ────────────    │                            │
  │                               ▼                            │
  │                     new DiagnosticAgent(...)               │
  │                     agent.investigate(anomaly)             │
  │                                       │                    │
  │                              ┌────────▼─────────┐          │
  │                              │  runAgentLoop:   │          │
  │                              │  model picks     │          │
  │                              │  each tool call  │          │
  │                              │  up to maxTurns  │          │
  │                              └──────────────────┘          │
  │                                       │                    │
  │                              (returns diagnosis)           │
  │                                                            │
  │  ────────── code takes over again ─────────                │
  │  new RecommendationAgent(...).propose(anomaly, diagnosis)  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The boundary was named by Anthropic and popularized in "Building Effective Agents" (2024). The industry converged on the framing because it drew the right decision line: chains for predictable pipelines, agents for open-ended tasks. Blooming's design predates AptKit's split but landed on the same shape — the older `lib/agents/base-legacy.ts` had this pattern hand-written; the AptKit migration formalized it.

The interesting failure mode is *agents where you should have written a chain*. A team that lets the model pick every step ends up with a system that occasionally does the wrong thing in unpredictable ways, at 5x the token cost. The `route.ts` supervisor is the *hardened* version — deterministic where predictable, autonomous only where genuinely needed.

## Interview defense

**Q: Is blooming_insights a single-agent or multi-agent system?**
A: Hybrid. The outer supervisor is a deterministic pipeline written in `app/api/agent/route.ts` — TypeScript picks the next agent, not an LLM. The inner workers (Diagnostic, Recommendation, Monitoring, Query) are each single-agent ReAct loops running through AptKit's `runAgentLoop`. Anthropic calls this a *deterministic-supervisor multi-agent system*, and it's the recommended production shape.

Diagram sketched: two boxes stacked — outer "code decides", inner "LLM decides".
Anchor: `app/api/agent/route.ts:266-297`.

**Q: When does the boundary belong at each altitude?**
A: Push code up as high as you can. If you can enumerate the sequence, code it. Every place the model picks the next step, you're paying for it in tokens, latency, and debugging surface. This repo pushes code all the way to the *pair* of agents (diagnose, then recommend) and only hands over inside each phase.

Diagram sketched: same two-layer picture with a dashed line labelled "push this line down as far as necessary, never further."
Anchor: same file.

## See also

- `02-agent-loop-skeleton.md` — what's inside the inner loop.
- `07-routing.md` — the classifyIntent router at the top of the chain.
- `03-multi-agent-orchestration/02-supervisor-worker.md` — the outer chain generalized to a supervisor topology.
- Cross-reference: `.aipe/study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` for the mechanics.
