# Chains vs agents — the boundary

**Industry standard.** The first distinction in agent architecture.

## Zoom out, then zoom in

This boundary sits at the orchestration layer — above the model, below the UI. Everything else in agent architecture builds on the answer.

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────────┐
  │  Feed (page.tsx)  →  fetch /api/briefing         │
  └────────────────────────────┬────────────────────┘
                               │  NDJSON
  ┌─ Orchestration layer ─────▼────────────────────┐
  │  route handler  →  ★ CHAIN vs AGENT? ★           │ ← we are here
  │  (briefing/route.ts, agent/route.ts)             │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Reasoning layer ─────────▼────────────────────┐
  │  MonitoringAgent / DiagnosticAgent / …          │
  │  (ReAct loops via @aptkit/core's runAgentLoop)  │
  └─────────────────────────────────────────────────┘
                               │
  ┌─ Provider layer ──────────▼────────────────────┐
  │  Anthropic + Bloomreach MCP server              │
  └─────────────────────────────────────────────────┘
```

The repo answers this boundary *twice* — once at the outer shell (chain) and once inside each stage (agent). That's the interesting answer.

## Structure pass

Layers, then one axis traced across them, then where the answer flips.

**Layers:** orchestration layer (route handler) → reasoning layer (an agent class) → runtime layer (`runAgentLoop`).

**Axis traced — "who decides control flow?":**

```
  One question, held constant down the layers

  "who decides control flow?"  — trace it downward

  ┌─ outer: route handler (briefing / agent) ────────┐
  │   CODE decides — the steps are written           │   workflow / chain
  └────────────────────────┬─────────────────────────┘
       ┌───────────────────▼────────────────────────┐
       │ inner: agent class (Monitoring / Diag / …) │
       │   CODE bridges — adapter just wires ports  │   workflow (thin)
       └───────────────────┬────────────────────────┘
           ┌───────────────▼────────────────────────┐
           │ innermost: runAgentLoop (AptKit)       │
           │   LLM decides — picks next tool / stop │   AGENT (ReAct)
           └────────────────────────────────────────┘
```

**Seam:** the boundary between the agent class (`lib/agents/monitoring.ts:82-93`) and the AptKit `AnomalyMonitoringAgent` is the load-bearing one. *Above* the seam, control flow is written by the engineer (`scan()` → constructs ports → calls `agent.scan()`). *Below* the seam, control flow is written by the LLM at runtime (which EQL query to issue, when to stop). The axis-answer flips across this boundary, so this is where the contract lives.

Mechanics hang on the skeleton. The route handler is a chain; the AptKit class wraps a loop; the seam carries the contract that makes the wrap possible.

## How it works

### Move 1 — the mental model

You know the difference between a `Promise` chain and a `while` loop. A chain runs a fixed number of steps, each transforming the previous one's output. A loop runs an unknown number of steps, checking a condition each time.

A workflow / chain is the `.then().then().then()` pattern at the orchestration level: the engineer writes the order, the LLM fills slots. An agent is the `while (not done)` pattern: the LLM decides whether to keep going on each iteration.

```
  The two shapes — same boxes, different control owner

  CHAIN (engineer-owned control flow):

    Input  →  Step 1  →  Step 2  →  Step 3  →  Output
              ▲           ▲          ▲
              │           │          │
            (LLM may       (LLM may    (LLM may
             fill a slot)   fill a slot) fill a slot)

    The arrows are hard-coded. The LLM never chooses
    what comes next; only what goes IN a step.


  AGENT (LLM-owned control flow):

    ┌──────────────────────────────────────────┐
    │              Agent control loop          │
    │   ┌─────────┐                            │
    │   │ Reason  │  ← LLM decides next action │
    │   └────┬────┘                            │
    │        ▼                                 │
    │   ┌─────────┐                            │
    │   │ Act     │  ← call a tool             │
    │   └────┬────┘                            │
    │        ▼                                 │
    │   ┌─────────┐                            │
    │   │ Observe │  ← read result             │
    │   └────┬────┘                            │
    │        └──────────── loop OR stop         │
    └──────────────────────────────────────────┘

    The arrows can curve back. The LLM emits an "action"
    or a "stop" — termination is data, not control flow.
```

### Move 2 — step by step

#### The route handler is a chain

Open `app/api/briefing/route.ts`. The relevant block is lines 208-289 — the `try` inside the stream's `start`. The steps are written in order:

```ts
// app/api/briefing/route.ts:215-262 (abridged)
req.signal.throwIfAborted();
step('reading the workspace schema…');
const schema = await bootstrap(req.signal);           // step 1
recordPhase('schema_bootstrap', t_schema);
// ...
const capabilities = schemaCapabilities(schema);     // step 2 (pure)
const coverage = coverageReport(capabilities);       // step 3 (pure)
const runnable = runnableCategories(capabilities);   // step 4 (pure)
// ...
const raw = await dataSource.listTools({ signal });  // step 5
// ...
const agent = new MonitoringAgent(...);              // step 6
const anomalies = await agent.scan({...}, runnable); // step 7 ← THE AGENT INSIDE THE CHAIN
```

Seven steps. The order is hard-coded. The LLM is consulted in step 7 (the `agent.scan()` call); steps 1-6 are pure plumbing — no LLM in the path. **This is the workflow shell.**

The investigation route (`app/api/agent/route.ts:220-302`) is the same shape, just with a `step === 'recommend'` branch and a `q && !insightId` branch for query.

The takeaway: if you removed every LLM from the repo, the chain (the route handler) would still *try* to run — it would just have nothing to put in step 7. The chain is a workflow regardless of what the agent does.

#### The agent is a loop

Now drop into `MonitoringAgent.scan()` in `lib/agents/monitoring.ts:82-93`. Eleven lines — it constructs the three AptKit ports (model, tools, trace) and delegates to `AnomalyMonitoringAgent.scan()`. That AptKit method runs `runAgentLoop`. Open `node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/run-agent-loop.js:20-105`:

```js
// run-agent-loop.js:25-57 (the kernel)
for (let turn = 0; turn < maxTurns; turn += 1) {
  signal?.throwIfAborted();
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,
    maxTokens,
    signal,
  });
  // ... emit trace, append response to messages ...
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) {
    finalText = text;
    break;  // ← success exit: the model said "I'm done"
  }
  // ... for each toolUse: call tool, push tool_result ...
}
// budget exit: the for-loop completed without break
```

That's the `while not done` pattern in `for`-loop clothing. The model picks each turn whether to emit another `tool_use` (keep going) or just text (stop). The engineer wrote `for (let turn = 0; turn < maxTurns; turn += 1)` — but did not write what happens *inside* each turn. **This is the agent inside the chain's step 7.**

#### The seam between them

The contract at the seam (the `agent.scan()` call) is exactly:

- **Input:** the engineer hands the agent a system prompt, a tool registry, a workspace context, and an abort signal.
- **Output:** the agent returns a typed result (`Anomaly[]`, `Diagnosis`, `Recommendation[]`).
- **Promise:** the agent will finish in bounded time (max-turns × max-tool-calls × max-tokens × call-duration) and will never make a tool call outside the allowlist.

The contract is small and the surface is narrow. That is what makes the chain-around-an-agent composable: the route handler doesn't know there's a loop inside; the loop doesn't know there's a chain outside.

### Move 3 — the principle

**Chain vs agent is a control-ownership decision, not a feature decision.** Anything you can do with an agent you can in principle do with a chain (write out every step), and vice versa (loop forever, fill no slots). The right question is *whose decision is the next step*: yours (write the chain) or the model's (start a loop).

The judgment that ships systems: **outer code, inner loop.** The repo's pattern is a deterministic shell that knows the workflow's shape — schema-bootstrap, then run the monitoring loop, then emit insights — wrapping single-agent loops that handle the parts you cannot enumerate up front (which EQL queries answer this anomaly). Each layer carries its complexity in the right place: code where the shape is known, model where it isn't.

## Primary diagram

```
  Chain wrapping an agent — the repo's load-bearing pattern

  ┌─ /api/briefing — the workflow shell ──────────────────────────────┐
  │                                                                   │
  │  schema     coverage    runnable     listTools    MonitoringAgent │
  │  bootstrap  report      categories   from MCP     .scan()         │
  │      │         │            │            │             │          │
  │      ▼         ▼            ▼            ▼             ▼          │
  │   step 1    step 2       step 3       step 4       ★ STEP 5 ★    │
  │   (code)    (code)       (code)       (code)       (the agent)    │
  │                                                       │           │
  │                                                       │           │
  │                          ┌────────────────────────────┘           │
  │                          ▼                                        │
  │              ┌─ runAgentLoop (AptKit) ─────────────────┐          │
  │              │   for (turn = 0; turn < maxTurns; ...) │          │
  │              │     response = model.complete(...)     │          │
  │              │     if (no tool_use) break  ← success   │          │
  │              │     else for each toolUse: callTool    │          │
  │              │   end for  ← budget exit                │          │
  │              └────────────────────────────────────────┘          │
  │                                                                   │
  │  ↑ CODE decides the order ────────────  LLM decides each turn ↑  │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The chain-around-an-agent pattern shows up everywhere production agent systems get serious — the LangGraph people call it "the graph wrapping the LLM-decided step"; the agent-framework people call it "the deterministic workflow with an LLM agent as one node." The vocabulary differs; the shape is the same.

The cost of the *all-agent* alternative (an LLM supervisor that decides "now run monitoring, now run diagnosis") would be: every step in your workflow is one more LLM call to decide whether to take it. For a five-step pipeline, that's at least five extra calls per request, plus a coordination overhead of 2-5x. The repo's deterministic shell skips that entire cost by accepting that the *shape* of the workflow is known (you always monitor before you diagnose; you always diagnose before you recommend) and only paying the LLM tax for the parts where the *path through the data* is genuinely unknown.

When the chain would need to become an agent: the moment the order of steps stops being knowable in advance. If a user could legitimately ask "diagnose first, then maybe also monitor" — sometimes — and your code can't enumerate the branches, then the orchestrator becomes an agent too. The repo's domain doesn't have that property: every investigation starts from a known anomaly, every recommendation starts from a known diagnosis.

## Interview defense

> **Q: How would you describe the orchestration in this codebase?**
>
> Workflow outside, single-agent inside. The route handlers in `app/api/briefing/route.ts` and `app/api/agent/route.ts` are deterministic TypeScript chains — schema bootstrap, coverage gate, list tools, run agent, emit results. The order is hard-coded. Inside each chain's `agent.scan()` (or `.investigate()` / `.propose()`) call, there's an autonomous ReAct loop in `@aptkit/core`'s `runAgentLoop` that decides which EQL query to issue and when to stop. The interesting thing is the seam between them: the agent class (`lib/agents/monitoring.ts:82-93`) is the boundary where the axis-answer flips from "CODE decides" to "LLM decides."
>
> Anchor: `lib/agents/monitoring.ts:82-93` (the seam) → `node_modules/.../runtime/.../run-agent-loop.js:25-57` (the kernel).

> **Q: Why isn't the whole orchestrator an agent — why is the outer shell a chain?**
>
> Two reasons. First, the order is genuinely known: you always monitor before you diagnose; you always diagnose before you recommend. There's nothing for an LLM to decide at the outer layer. Second, the cost: an LLM supervisor adds one more model call per pipeline step plus the 2-5x coordination overhead that multi-agent always carries. Paying that tax for a problem that doesn't have it is the canonical "I read about multi-agent" mistake. The repo only pays the agent tax inside each step, where the path through the data genuinely isn't enumerable.

> **Q: When would you make the outer shell an agent?**
>
> When the order of pipeline steps stops being knowable in advance. If a user could legitimately say "skip diagnosis and go straight to recommendations" *sometimes*, and your code can't enumerate the branches with simple `if`s, then routing becomes a model decision. That's the supervisor-worker topology. Until then, the deterministic shell is doing the same work for ~5% of the cost.

## See also

- → `02-agent-loop-skeleton.md` — the kernel inside the inner agent
- → `03-react.md` — the prompting pattern the loop runs
- → `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the longer-form version of the "why deterministic outer shell" argument
- → cross-reference (when generated): `study-ai-engineering`'s `04-agents-and-tool-use/01-agents-vs-chains.md` — the per-call mechanics
- → cross-reference (when generated): `study-system-design`'s request-flow file — the full HTTP path the chain runs on
