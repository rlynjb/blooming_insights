# Agents vs chains

*Industry standard — agent (loop, LLM-decided) vs chain (linear, code-decided)*

## Zoom out — where this concept lives

This codebase has both shapes. **Agents** (monitoring, diagnostic, recommendation, query) each run a ReAct-style loop where the LLM decides which tool to call next. **A chain** sits *between* them: the route layer runs `bootstrap → diagnose → recommend` in fixed order, where the LLM never picks the next step. Hybrid: pipeline outside, loop inside.

```
  Zoom out — where the loop and the chain sit

  ┌─ Route layer (the CHAIN — code-decided) ────────────────┐
  │  bootstrap → scan (monitoring) → click card →           │
  │  → diagnose → click "see recs" → recommend              │
  │  every transition between agents is YOUR code's call    │
  └────────────────────┬────────────────────────────────────┘
                       │  invokes one agent per step
                       ▼
  ┌─ Inside each agent (the LOOP — LLM-decided) ────────────┐
  │  while not done:                                         │
  │    LLM thinks                                            │
  │    LLM picks a tool from the allowlist                   │
  │    YOUR code runs the tool                               │
  │    LLM sees the result                                   │
  │  done = LLM emits final synthesis OR call budget hit     │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Pipeline outside, loop inside. The pipeline's fixed because the user's mental model is fixed (`what changed → why → what to do`). The loop's flexible because each "why" investigation needs different EQL depending on the anomaly.

## Structure pass — layers · axes · seams

**Layers:** product flow (chain) → agent (loop) → tool call.

**Axis: who decides what happens next?** Chain layer: CODE decides. Loop layer (inside each agent): LLM decides. The decision-flip lives at the agent entry point.

**Seam:** the agent constructor call (`new MonitoringAgent(...).scan(...)`, `new DiagnosticAgent(...).investigate(anomaly)`). Outside that call, your code is in control. Inside, the LLM is.

## How it works

### Move 1 — the mental model

You know how a `for` loop runs a fixed number of times but a `while` loop runs until a condition? Same shape — chains have a fixed step list (`for step of steps`); agents loop until a condition (`while not done`).

```
  Chains vs agents — the loop structure

  Chain (fixed steps):
   ─────────────────
   input  →  step 1  →  step 2  →  step 3  →  output
            (LLM)      (LLM)       (LLM)

   YOU define the steps; the LLM only chooses what to write within each.

  Agent (loop, unpredictable count):
   ──────────────────────────────────
   input  →  ┌──────────────────────────┐
             │  thought → action → obs   │
             │  thought → action → obs   │
             │  thought → action → obs   │  ← LLM decides each iteration
             │     ...                   │
             │  thought → final answer   │
             └──────────────────────────┘
                       │
                       ▼
                     output
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the chain lives in the route.**

`app/api/agent/route.ts:280-296` is the chain. It runs the diagnostic agent, emits the diagnosis, then runs the recommendation agent. No LLM is involved in deciding "should I run recommendation next?" — that's hardcoded:

```typescript
// STEP 2 (diagnose) or the combined run: run the diagnostic agent.
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) throw new Error('no diagnosis was handed over — open the diagnosis step first');
} else {
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
  send({ type: 'diagnosis', diagnosis });
}

// STEP 3 (recommend) or the combined run: run the recommendation agent.
if (step !== 'diagnose') {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

Fixed two-step pipeline. The conditional is on `step` (the user-facing UX choice), not on any LLM decision.

**Part 2 — the loop lives inside each agent (in AptKit).**

When `diagAgent.investigate(anomaly)` runs, it doesn't return on the first LLM call. It enters a ReAct loop:

```
  LLM call 1 (system + user "investigate this anomaly"):
    → output: { text: "I need to check…", tool_use: 'execute_analytics_eql' }
   Your code executes the EQL via DataSource.callTool.
   The result becomes a 'tool_result' content block.

  LLM call 2 (system + user + assistant + tool_result):
    → output: { text: "now let me check…", tool_use: 'get_funnel' }
   Your code runs the tool. Result fed back.

  LLM call 3 (... + tool_result + tool_result):
    → output: { text: "Cart abandonment is up because…", tool_use: null }
   No tool call this turn → done.

  Loop exits. Final synthesized Diagnosis returned.
```

The number of calls is LLM-decided, capped at the agent's budget (`monitoring.md:18` enforces 6; diagnostic has its own cap inside AptKit). This codebase's agents typically run 5-8 tool calls per investigation.

**Part 3 — both shapes are valid; pick by the decision shape.**

```
  When to use a chain                When to use an agent
   ─────────────────────              ─────────────────────
   Steps known in advance              Steps depend on results

   Latency matters (fewer LLM calls)   Coverage matters more than latency

   Each step has one clear job         Each "step" is "do whatever it takes"

   Deterministic UX                    Open-ended investigation

   Example: bootstrap →                Example: diagnose anomaly
            scan →                              (which EQL? depends on
            insight                              anomaly shape, depends
                                                  on results so far)
```

**Part 4 — this codebase's choice, named.**

Chain at the product flow: the user thinks `what → why → what to do`, in that order, always. No LLM should decide whether to "skip diagnosis." The fixed three-step shape *is* the product.

Loop inside each agent: each "what" or "why" is open-ended. Different anomalies need different tool sequences. The 10 anomaly categories share one agent because the categories are reference material; the EQL choices are not.

### Move 3 — the principle

**Pipeline outside, loop inside.** The outer shape (product flow) is what you design; the inner shape (per-agent reasoning) is what the LLM is good at. Where the line falls between them is the load-bearing design decision. Get the line right and your app is testable, debuggable, and fast; get it wrong and either the user sees a black box or the agent makes brittle structural decisions.

## Primary diagram — the full recap

```
  Pipeline outside, loop inside

  ┌─ Pipeline (chain) — code-decided ───────────────────────────┐
  │                                                              │
  │   bootstrap                                                  │
  │       │                                                      │
  │       ▼                                                      │
  │   monitoring scan (briefing) ─────► insight list             │
  │       │ user clicks a card                                   │
  │       ▼                                                      │
  │   diagnostic investigation ───────► Diagnosis                │
  │       │ user clicks "see recs"                               │
  │       ▼                                                      │
  │   recommendation proposal ────────► Recommendation[]         │
  │                                                              │
  └─────────┬────────────────────────────────────────────────────┘
            │  for each pipeline step, invoke one agent
            ▼
  ┌─ Agent loop — LLM-decided ──────────────────────────────────┐
  │                                                              │
  │  ┌──── while not done ──────────────────────────────────┐    │
  │  │                                                      │    │
  │  │   model.complete(prompt + history)                   │    │
  │  │      ↓                                               │    │
  │  │   ContentBlock[] — text and/or tool_use blocks       │    │
  │  │      ↓                                               │    │
  │  │   for each tool_use:                                 │    │
  │  │     dataSource.callTool(name, input)                 │    │
  │  │     append tool_result to history                    │    │
  │  │                                                      │    │
  │  │   if no tool_use this turn:                          │    │
  │  │     extract final structured output                  │    │
  │  │     break                                            │    │
  │  │                                                      │    │
  │  │   if call budget hit:                                │    │
  │  │     force final answer                               │    │
  │  │     break                                            │    │
  │  │                                                      │    │
  │  └──────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why both, not just one.** Pure chain would force the codebase to hard-code which EQL to run for each anomaly category — brittle, doesn't scale to 10+ categories. Pure agent would let the LLM decide "should I diagnose before recommending?" — wrong call, because the user already decided that by clicking "see recs."

The hybrid lands where the decisions live: structural at the chain level, semantic at the loop level.

**Why the agent loop lives in AptKit, not this repo.** AptKit's `AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, etc. each implement a tuned version of the ReAct loop for their domain (monitoring has 6-call budget + category checklist; diagnostic has hypothesis-testing structure; recommendation has feature-selection logic). Building those loops correctly is a library's job — testing, error recovery, budget enforcement, prompt design — and this codebase delegates by depending on the abstraction (`@aptkit/core`).

The 206 LOC of adapter glue at `lib/agents/aptkit-adapters.ts` is the entire boundary between "this codebase" and "the agent runtime."

## Project exercises

### Exercise — Turn the briefing scan from "always monitor" to LLM-decided category prioritization

  → **Exercise ID:** B4.1
  → **What to build:** Add an *outer* LLM call before the monitoring scan that prioritizes which categories to run based on recent activity (e.g. "the last 3 anomalies were revenue-related — prioritize revenue_drop and conversion_drop over inventory and fraud this scan"). Pass the prioritized order to `MonitoringAgent.scan()`. Pure agent layer added in front of the existing chain.
  → **Why it earns its place:** demonstrates pushing decision-making from the chain layer (today: run all runnable categories) to a thin LLM layer (smart-prioritize before scanning). The pattern transfers to any chain step where the "always do all of these" rule is wasteful.
  → **Files to touch:** new `lib/agents/category-prioritizer.ts` (a small Haiku-backed prioritizer), `lib/agents/monitoring.ts` (accept a prioritized order), `app/api/briefing/route.ts` (run the prioritizer before scan), `test/agents/category-prioritizer.test.ts` (cover the prioritization shape).
  → **Done when:** the briefing scan now runs categories in a prioritized order (typically 4-5 in the front, others at the back), the per-call log shows the prioritization step costs ~$0.0003 (Haiku), and the existing scan behavior is preserved when the prioritizer falls back.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Are your agents chains or agents?"**

Both. The product flow is a chain — bootstrap → scan → diagnose → recommend, in fixed order, decided by the user's clicks and the route's hardcoded sequence. Inside each step, an agent runs a ReAct-style loop: the LLM picks a tool from its allowlist, my code executes it, the result feeds back, the LLM decides next. Pipeline outside, loop inside. The outer chain is the product; the inner loop is what the LLM is good at.

*Anchor: "Pipeline outside, loop inside. Decision-flip at the agent constructor call."*

**Q: "Why isn't the recommendation agent allowed to call diagnostic tools?"**

Allowlist at `lib/mcp/tools.ts:28-36`. The recommendation agent has 7 tools, all for proposing Bloomreach actions (`list_scenarios`, `list_segmentations`, `list_voucher_pools`, etc.). It can't call `execute_analytics_eql` because that's a diagnostic-shaped tool — once you're recommending, you've already accepted the diagnosis. If the agent's allowed to re-diagnose mid-recommendation, it'll spend its budget questioning the handoff instead of proposing actions.

This is the chain layer's job (deciding "we're past diagnosis now"); the agent layer respects it by tool-list narrowing.

*Anchor: "Chain decides which agent runs; agent's tool allowlist narrows what the LLM can pick."*

## See also

  → `02-tool-calling.md` — the per-tool mechanics
  → `03-react-pattern.md` — the loop's inner shape
  → `02-context-and-prompts/03-prompt-chaining.md` — the same pattern from the prompt-chain lens
