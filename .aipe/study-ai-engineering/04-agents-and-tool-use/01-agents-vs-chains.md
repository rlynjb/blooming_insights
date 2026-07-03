# 01 — Agents vs chains

**Type:** Industry standard. Also called: static pipeline vs dynamic loop, deterministic composition vs LLM-driven control.

## Zoom out, then zoom in

The shape distinction between "the code decides the steps" and "the LLM decides the steps." This codebase has BOTH: chains between agents (diagnose → recommend) and ReAct loops inside each agent.

```
  Zoom out — both shapes in this repo

  ┌─ Outer: chain (code-decided) ─────────────────────────────────────┐
  │  MonitoringAgent → user picks → DiagnosticAgent → RecommendationAgent│
  │  code owns the order; LLM owns each stage                          │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Inner: agent loop (LLM-decided) ──▼──────────────────────────────┐
  │  Thought → Action → Observation → Thought → ... → Conclusion       │
  │  LLM owns the order; code owns tool dispatch                       │
  │  ★ THIS CONCEPT — the distinction ★                                │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Chain = static composition, one order, deterministic. Agent = dynamic loop, LLM picks the next step, non-deterministic count of iterations. This repo composes them: a fixed chain between stages, a ReAct loop inside each stage.

## Structure pass

**Layers:**
- Outer: the whole product flow
- Middle: individual stages
- Inner: what happens inside one stage

**Axis: who decides control flow?**
- Outer (product flow): CODE decides (monitoring → user click → investigate step 2 → step 3)
- Middle (stage): CODE decides (each stage is one agent call)
- Inner (stage internals): LLM decides (thought → tool_use → observation → thought → ...)

**Seam:** the boundary between chain-level and agent-level. Above: `app/api/agent/route.ts` orchestrates stages by `step=diagnose|recommend`. Below: AptKit's agent loop runs until the model says done.

## How it works

### Move 1 — the mental model

You've written a build pipeline (`lint → test → deploy`) and a while loop (`while (not done) { work }`). Same shapes, different scales.

```
  Chain — code-decided, fixed order

  input → step1 → step2 → step3 → output
       (compile-time count of steps)


  Agent loop — LLM-decided, dynamic

  input
    │
    ▼
  ┌─────────┐
  │Thought  │ ← LLM: "what next?"
  └────┬────┘
       │
       ▼ pick tool
  ┌─────────┐
  │Action   │ ← code runs the tool
  └────┬────┘
       │
       ▼
  ┌─────────┐
  │Observation│ ← LLM reads result
  └────┬────┘
       │
       └──── loop or stop (LLM decides)
```

### Move 2 — walk the mechanism

**The chain in this codebase.**

Monitoring → user selects an insight → Diagnostic → Recommendation. Each hand-off is deterministic. Anomaly + selected insight go to diagnostic; anomaly + diagnosis go to recommendation. Split across three files:
- `lib/agents/monitoring.ts` — `MonitoringAgent.scan()`
- `lib/agents/diagnostic.ts` — `DiagnosticAgent.investigate()`
- `lib/agents/recommendation.ts` — `RecommendationAgent.propose()`

Each stage is invoked exactly once per investigation. Order is fixed. No re-planning at the chain level.

**The agent loop inside a stage.**

`DiagnosticAgent.investigate(anomaly, hooks)` at `lib/agents/diagnostic.ts:46-63` delegates to `AptKitDiagnosticInvestigationAgent.investigate()`. AptKit runs the loop:

```
  (inside AptKit — simplified from @aptkit/core)

  const messages = [system, user(anomaly)];
  while (turnsRemaining > 0) {
    const response = await modelProvider.complete({ messages, tools });
    messages.push({ role: 'assistant', content: response.content });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) break;                   // model finished thinking

    if (toolUse.name === 'submitDiagnosis') {
      return toolUse.input as Diagnosis;   // final answer
    }

    const result = await toolRegistry.callTool(toolUse.name, toolUse.input);
    messages.push({ role: 'user', content: [{ type: 'tool_result', ... }] });
    turnsRemaining--;
  }
```

The loop is deterministic mechanics; the DECISIONS inside the loop (which tool, when to submit, how to phrase the thought) are the model's. That's why it's an "agent loop" — code owns the loop; the model owns the loop's body decisions.

**Why chain-of-agents rather than one big agent.**

Three reasons (also covered in `02-context-and-prompts/03-prompt-chaining.md`):
1. Evaluability — separate rubrics per stage
2. Streaming — two-page product UI maps to two agents
3. Independent iteration — change one prompt without retesting the other

**Why an agent loop rather than a chain of prompts inside a stage.**

Because the diagnostic path IS unpredictable at the tool-call level. The agent might need 3 tool calls or 6. Which specific EQL queries to run depends on what the earlier results showed. A hard-coded chain of prompts would either miss cases (too rigid) or be enormous (branch on every possibility).

### Move 3 — the principle

Compose. Fixed order at the product-flow layer where determinism matters (each investigation has three well-defined stages). Dynamic loop inside a stage where the model has to react to what it discovers. The right shape at the right layer — chains all the way down is too rigid; agents all the way up is too flexible.

## Primary diagram

Full picture — both shapes in this repo.

```
  Chain + agent-loop composition in blooming_insights

  ┌─ Product flow (CHAIN — code decides) ─────────────────────────────┐
  │                                                                   │
  │   MonitoringAgent.scan()                                          │
  │        │                                                          │
  │        ▼                                                          │
  │   emits Anomaly[]                                                 │
  │        │                                                          │
  │        ▼  ← user picks an anomaly (human-in-the-loop step)         │
  │                                                                   │
  │   DiagnosticAgent.investigate(anomaly)                            │
  │        │                                                          │
  │        │ [inner: agent loop]                                       │
  │        │  ┌──────────────────────────────────────┐                │
  │        │  │  T → A → O → T → A → O → ... → done  │                │
  │        │  │  ≤ 6 tool calls · ≤ 10 model turns   │                │
  │        │  └──────────────────────────────────────┘                │
  │        │                                                          │
  │        ▼                                                          │
  │   emits Diagnosis                                                 │
  │        │                                                          │
  │        ▼                                                          │
  │   RecommendationAgent.propose(anomaly, diagnosis)                 │
  │        │                                                          │
  │        │ [inner: agent loop, own tools loop]                       │
  │        │                                                          │
  │        ▼                                                          │
  │   emits Recommendation[]                                          │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "agent vs chain" distinction landed as vocabulary around 2022-2023 (LangChain named it; the ReAct paper had the mechanism). Before that, "agents" meant AI research agents (goal-directed RL policies) and "chains" meant Unix pipelines. The AI-app-eng usage narrowed both: chain = deterministic composition of LLM calls; agent = LLM-controlled tool-use loop.

Modern production reality is almost always compositional — chains of agents. The tradeoffs favor chain-when-you-can, agent-when-you-must. Chain-of-thought reasoning inside a single non-tool-using LLM call is a third shape (agent-like reasoning without agent-like tool use); this codebase uses it implicitly (the model's `text` blocks are its reasoning, streamed as `reasoning_step` events), but the primary control is agent-loop shape.

## Project exercises

### Exercise — force a chain-only diagnostic and measure

- **Exercise ID:** C4.1-A · Case A (concept exercised; measure the trade).
- **What to build:** implement a `ChainDiagnosticAgent` variant that runs a hard-coded 3-step sequence: (1) `execute_analytics_eql` for the metric time-series, (2) `execute_analytics_eql` for a country breakdown, (3) synthesize with one final model call. No LLM-decided tool routing. Run against the 10 goldens and compare quality vs the agent-loop version.
- **Why it earns its place:** proves you know the agent-loop is a design choice, not a default. Interviewer signal: "I know when a chain would suffice and when the loop is buying real flexibility — here's the measurement."
- **Files to touch:** `lib/agents/chain-diagnostic.ts` (new), `eval/run.eval.ts` (two-arm run).
- **Done when:** report shows per-dim pass rates for chain-only vs agent-loop on the 10 goldens. Expected: chain-only wins on happy-path cases (01-04) and loses on partial-signal (05, 06).
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Is diagnostic an agent or a chain?**

Both, at different scales. At the product-flow layer it's a chain — Monitoring → Diagnostic → Recommendation, fixed order. Inside the Diagnostic stage, it's an agent — a ReAct loop that decides what to query next based on what previous queries showed. The chain gives determinism where I want it; the agent gives flexibility where I need it.

**Q: Why not one big agent that does monitoring + diagnostic + recommendation?**

Because "diagnose this anomaly" and "propose a recommendation" have different rubrics. Merging them into one agent's loop would mean one rubric scoring both jobs at once — I couldn't tell whether a failure was in the diagnosis or the recommendation. Two agents = two rubrics = clean signal.

```
  Chain gives me:
   · separable rubrics per stage
   · streaming boundary between UI pages
   · independent prompt iteration
```

**Q: Why not chains-inside-stages?**

Because the diagnosis path is unpredictable at the tool-call level. Some anomalies need 3 queries (clear signal); some need 6 (multi-scope digging). Some need a country breakdown; some need a device breakdown. A hard-coded chain would either miss cases (too rigid) or fan out to a big decision tree (equivalent to an agent anyway, just harder to iterate on).

## See also

- `02-tool-calling.md` — the mechanism the agent loop uses
- `03-react-pattern.md` — the specific shape of the loop
- `02-context-and-prompts/03-prompt-chaining.md` — the chain shape at product-flow level
- `lib/agents/diagnostic.ts`, `lib/agents/recommendation.ts`
