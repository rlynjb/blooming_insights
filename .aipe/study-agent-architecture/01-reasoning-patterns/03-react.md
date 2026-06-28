# ReAct

*Industry name: ReAct (Reason + Act) — Industry standard.*

ReAct is the prompt shape that fills the loop kernel. All four loop-shaped agents in this repo are ReAct. This file places it in the family — the mechanics live in `02-agent-loop-skeleton.md` and the prompts live in `lib/agents/legacy-prompts/*.md`.

## Zoom out — where this concept lives

ReAct sits at the agent layer. Same skeleton as `02-agent-loop-skeleton.md`; the difference is that the prompt asks the model to *reason out loud* before each tool call. In this repo, that reasoning becomes the `reasoning_step` events streamed to the StatusLog UI.

```
  Where ReAct lives in blooming insights

  ┌─ Service layer ─────────────────────────────────────────┐
  │  /api/briefing  /api/agent                              │
  └────────────────┬────────────────────────────────────────┘
                   │
  ┌─ Agent layer ──▼────────────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent│
  │  QueryAgent  → all ReAct (prompt shape + loop kernel)   │ ← we are here
  └────────────────┬────────────────────────────────────────┘
                   │
  ┌─ AptKit runtime layer ──────────────────────────────────┐
  │  runAgentLoop (the kernel from 02-agent-loop-skeleton)  │
  └─────────────────────────────────────────────────────────┘
```

## Structure pass — the seam between "reasoning" and "action"

The axis to hold: **what's the model emitting on each turn?** ReAct's whole contribution is that it's BOTH — a text block (the reasoning) AND a tool_use block (the action), in the same response. The kernel doesn't care; ReAct uses it.

```
  One turn, two outputs

  ┌─ Model response ──────────────────────────────────────┐
  │  content: [                                            │
  │    { type: 'text', text: "Let me check the 90-day...  │ ← Reason
  │       This will tell me if the trend holds."         │   (streamed to UI)
  │    },                                                  │
  │    { type: 'tool_use', name: 'execute_analytics_eql',  │ ← Act
  │      input: { eql: 'select count event purchase...' } │   (harness runs)
  │    }                                                   │
  │  ]                                                     │
  └────────────────────────────────────────────────────────┘
```

The seam between the two blocks is load-bearing for THIS repo: the text block is what becomes the live `reasoning_step` event in the StatusLog. ReAct's "reason out loud" is what makes the UI's streaming feel like watching an analyst think.

## How it works

### Move 1 — the mental model

You know how every `useState` setter is paired with the corresponding `useEffect` that runs when the state changes? ReAct is the same pairing for the model: every action is paired with a thought that justifies it. The prompt forces the pairing; the kernel just runs the loop.

```
  ReAct — thought + action, every turn

      ┌──────────────────────────────────────────────┐
      │  prompt: "think out loud, then call a tool"  │
      └──────────────────────┬───────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │  turn 1         │
                    │  thought: ...   │ → streamed to UI as
                    │  tool_use: X    │   `reasoning_step`
                    └────────┬────────┘
                             ▼ tool result
                    ┌─────────────────┐
                    │  turn 2         │
                    │  thought: ...   │
                    │  tool_use: Y    │
                    └────────┬────────┘
                             ▼ ...
                    ┌─────────────────┐
                    │  turn N (final) │
                    │  thought: ...   │
                    │  text: JSON     │ → parsed as Diagnosis/Anomaly[]
                    └─────────────────┘
```

### Move 2 — walkthrough with the diagnostic agent's prompt

**The prompt asks for hypotheses up front.**

The DiagnosticInvestigationAgent's prompt (`@aptkit/prompts/diagnostic.d.ts` — quoted at the package source) is a classic ReAct shape:

> "Generate 2-3 competing hypotheses, query the available tools to test them, and return the best-supported explanation with evidence. … Hard rules: Make at most 6 tool calls, then conclude. … Recommended approach: 1. Generate 2-3 hypotheses before the first tool call. 2. Query to falsify each hypothesis. 3. Spend one call locating when the change happened. 4. Conclude with the hypothesis that best fits the evidence."

What this is: an instruction to do ReAct's loop with a specific *strategy* — hypothesize, test, conclude. The kernel still runs the loop; the prompt shapes what the model does inside it.

**The trace becomes the UI.**

In `app/api/agent/route.ts:196-210`, the route hooks each turn's text into a `reasoning_step` event:

```typescript
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent,
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
});
```

`onText` fires on every text block in every turn — that's the "Reason" half of ReAct. `onToolCall` fires when a tool_use block runs — that's the "Act" half. Both stream as NDJSON to the StatusLog. **The product surface IS the ReAct trace.** That's not a coincidence; the prompt was chosen because its reasoning-then-action shape produces something the UI can show.

**Why ReAct for all four agents and not something fancier?**

The escalation framing from the spec applies. Default to ReAct; only escalate when a specific failure mode is identified that ReAct can't address. In this repo:

```
  Default to ReAct → did anything fail?
    │
    ├─ monitoring: does the model pick reasonable EQL queries?
    │              → yes; the schema-gated category list (`{categories}`
    │                slot) constrains the search space enough
    │              → STAY ReAct
    │
    ├─ diagnostic: does it form testable hypotheses?
    │              → yes; the prompt instruction "generate 2-3 hypotheses
    │                before the first tool call" is enough scaffolding
    │              → STAY ReAct (could escalate to plan-execute later)
    │
    ├─ recommendation: does it ground in the diagnosis?
    │              → yes; the diagnosis is in the user message
    │              → STAY ReAct (tighter budget: 4 tool calls, not 6)
    │
    └─ query: does it pick the right tool?
                   → mostly; the intent classifier (cheap haiku) labels
                     the question first so the prompt has a frame
                   → STAY ReAct
```

The interview-grade answer: "We built a ReAct baseline, measured it through the streamed AgentEvent traces, and have NOT yet identified a failure mode the baseline can't address. Plan-and-execute and reflexion are on the table when a specific failure justifies their tax."

### Move 3 — the principle

ReAct's contribution wasn't a new loop shape — the loop kernel is older. The contribution was treating reasoning as observable output. The model thinks out loud, you read the thinking, you debug the trajectory. This repo bought that contribution literally: the reasoning IS the product surface. The "blooming insights" pitch — "an analyst that shows its work" — is just ReAct's text block streamed to a sidebar.

## Primary diagram

ReAct in this repo, end-to-end: prompt asks for thought+action, kernel runs the loop, hooks stream both halves to the UI.

```
  ReAct end-to-end in blooming insights

  ┌─ prompt (lib/agents/legacy-prompts/diagnostic.md OR @aptkit/prompts) ─┐
  │  "Generate 2-3 hypotheses. Query to falsify each. Make at most 6      │
  │   tool calls, then conclude with a JSON object."                       │
  └────────────────────────────────┬──────────────────────────────────────┘
                                   ▼
  ┌─ runAgentLoop (kernel) ──────────────────────────────────────────────┐
  │  while not done {                                                     │
  │    res = model.complete(prompt + history)                             │
  │    onText(text blocks)  ───────────► `reasoning_step` event ──┐      │
  │    for each tool_use:                                          │      │
  │      onToolCall(tc) ────────────────► `tool_call_start` event ─┤      │
  │      result = dataSource.callTool(...)                         │      │
  │      onToolResult(tc) ──────────────► `tool_call_end` event ──┤      │
  │    history.push(...)                                            │      │
  │  }                                                              │      │
  └─────────────────────────────────────────────────────────────────┼─────┘
                                                                    ▼
  ┌─ UI (components/shared/StatusLog.tsx + ReasoningTrace.tsx) ─────────┐
  │  badge + step kind + content + timestamp                              │
  │  ToolCallBlock with status dot, tool name, duration, expandable JSON  │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct was introduced by Yao et al. in 2022 ("ReAct: Synergizing Reasoning and Acting in Language Models"). The paper's claim was that interleaving reasoning traces with action steps beat both pure-reasoning (CoT) and pure-action (act-only) baselines on QA and decision tasks. The mechanism: reasoning helps the model decide which action to take next; the action's result grounds the reasoning so it doesn't drift.

In production, ReAct became the default single-agent pattern partly because Anthropic's `tool_use` block format makes it the path of least resistance — emit text + tool_use in the same response, no prompt gymnastics required. LangChain's early `AgentExecutor` baked ReAct in; OpenAI's function calling did the same with a different syntactic skin.

The escalation ladder past ReAct is real but expensive. Plan-and-execute (one expensive planning call, then cheap executors) wins on structured tasks where the plan can be pre-committed. Reflexion (self-critique loop) wins when the failure mode is "model produced flawed output it could have caught itself." Neither beats ReAct on dynamic exploration; both add 2-5x token cost. The senior-grade move is naming what specific failure justified the escalation.

## Interview defense

**Q: "Why ReAct and not plan-and-execute or reflexion?"**

A: We built ReAct as the baseline and never identified a failure mode that justified escalating. The diagnostic agent's prompt does a soft plan-and-execute via "generate 2-3 hypotheses up front, then test each" — but the model can still re-plan inside the loop, which is ReAct's strength on data exploration. Reflexion would mean a second agent re-grading the diagnosis; we don't have it because the failure mode it catches (subtle reasoning errors the producer missed) shows up rarely in our domain — the diagnoses are grounded in tool-call evidence the user can inspect directly via the streamed trace, so the human IS the reflexion step.

Diagram I'd sketch:

```
  ┌─ ReAct (here) ─────────┐    Escalate only on a named failure:
  │  reason → act → repeat │       plan-execute  → if path is known
  │  thought + tool, paired│       reflexion     → if subtle errors
  │  with maxToolCalls cap │       ToT           → ~never worth it
  └────────────────────────┘
```

Anchor: "the reasoning IS the product surface — `onText` in `route.ts` line 197 hooks every text block into a `reasoning_step` event. The StatusLog literally shows ReAct's thoughts as they stream."

**Q: "Does the model actually reason, or is it just text the prompt asked for?"**

A: Both — and the right framing is that we don't care. What we care about is whether the *next tool call is reasonable given the previous result*, and the streamed trace lets us verify that. When the diagnostic agent says "the conversion drop is concentrated in mobile, let me check checkout step abandonment" and then calls `execute_analytics_eql` with a query that does exactly that — the reasoning predicted the action. When it doesn't, that's a prompt bug we can see in the trace. The "is it real reasoning" question is a research question; the "does the trace let me debug" question is the engineering question, and the answer there is yes.

## See also

- [`02-agent-loop-skeleton.md`](./02-agent-loop-skeleton.md) — the kernel ReAct fills
- [`04-plan-and-execute.md`](./04-plan-and-execute.md) — the escalation alternative this repo hasn't reached for
- [`05-reflexion-self-critique.md`](./05-reflexion-self-critique.md) — the other escalation alternative
- [`../04-agent-infrastructure/01-context-engineering.md`](../04-agent-infrastructure/01-context-engineering.md) — what fills the prompt that ReAct reasons over
- ai-engineering's `04-agents-and-tool-use/03-react-pattern.md` (cross-ref) — the loop mechanics, if generated
