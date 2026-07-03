# The ReAct pattern

## Subtitle

Thought / Action / Observation loop — Industry standard.

## Zoom out, then zoom in

Every agent in blooming runs a ReAct loop under the hood, courtesy of `@aptkit/core`. ReAct — Reasoning + Acting — is the shape where the model alternates "thought" (natural-language reasoning about what to do next) with "action" (a tool call) and "observation" (the tool's result). The user sees this trace live in `StatusLog` because each `reasoning_step` and `tool_call_*` event maps 1:1 to a ReAct step.

```
  Zoom out — where ReAct shows up

  ┌─ UI ────────────────────────────────────────────────┐
  │  StatusLog renders each thought + tool call live     │
  │  components/shared/StatusLog.tsx                     │
  └───────────────────────┬──────────────────────────────┘
                          │  NDJSON events
                          ▼
  ┌─ Route ────────────────────────────────────────────┐
  │  emits reasoning_step, tool_call_start/end          │
  └───────────────────────┬──────────────────────────────┘
                          │  from AgentHooks
                          ▼
  ┌─ aptkit agent loop ★ ──────────────────────────────┐ ← we are here
  │  Thought (LLM text) → Action (tool_use)              │
  │    → Observation (tool_result) → back to Thought     │
  └──────────────────────────────────────────────────────┘
```

Zoom in: ReAct is a specific loop shape, not just "an agent." The pattern is Thought explicitly interleaved with Action.

## Structure pass

- **Layers:** Thought → Action → Observation → Thought → ... Cycle.
- **Axis: what each phase produces.** Thought: text explaining the plan. Action: tool_use. Observation: tool_result. Same pattern, different phase.
- **Seam:** the transitions between phases. The model decides when to move from thought to action; the code decides when action becomes observation.

## How it works

### Move 1 — the mental model

The trace of a diagnostic investigation looks like a decision journal:

```
  ReAct trace — one investigation

  Question: "diagnose the mobile revenue drop"

  Thought 1: "I need to check if the drop is checkout-stage or funnel-wide."
  Action 1:  execute_analytics_eql(eql="funnel by step, mobile, last 90d")
  Observation 1: { view: 100k, cart: 34k, checkout: 18k, purchase: 4.9k }

  Thought 2: "Checkout → purchase step lost the most. Let me check
              payment failures."
  Action 2:  execute_analytics_eql(eql="payment_failure_rate over 90d")
  Observation 2: { current: 0.046, prior: 0.035, +31.2% }

  Thought 3: "Payment failures rose in the same window. That's likely the
              primary cause."
  Action 3:  submit_diagnosis({ conclusion: "payment processor spike...",
                                evidence: [...], hypothesesConsidered: [...] })
  → agent stops
```

### Move 2 — the step-by-step walkthrough

**Why interleave thought and action.** Two reasons. (1) Debuggability — when the diagnosis is wrong, the trace tells you which thought led there. (2) Steerability — the thought text is what the model would use to justify its own next step, which tends to keep it grounded.

**How blooming surfaces it.** Every `reasoning_step` event that fires with `kind: 'thought'` is a Thought. Every `tool_call_start` is an Action; the matching `tool_call_end` is an Observation. `components/investigation/ReasoningTrace.tsx` renders each with a timestamp, agent badge, and tool call detail. The user's experience of the ReAct trace *is* the ReAct trace.

**The trace as an interview artifact.** When you're debugging why case 08 got "pause the A/B experiment" as a rec, the ReAct trace is where you look. You can see turn-by-turn where the diagnostic agent went — did it check payment_failure? At what turn? Did the recommendation agent read that evidence when composing its output? The trace answers, not a post-hoc reconstruction.

**Where ReAct breaks.** Two failure modes:

- **Loop on same tool.** Model calls the same tool with the same args 3 times because it can't parse the result. Detected by loop-detection code (see **06-error-recovery.md**).
- **Skip thoughts.** Model emits `tool_use` blocks with no interleaving text. Loses debuggability. Sometimes an artifact of the model's training; usually indicates the prompt didn't ask for thoughts.

Execution trace of the ReAct loop as pseudocode:

```
  reactLoop(question, tools):
    messages = [{ role: "user", content: question }]
    while turnCount < max_iterations:
      response = model.complete({ messages, tools })
      if response.stop_reason == "end_turn":
        return response.final_content
      // otherwise response contains tool_use(s) — action phase
      messages.push({ role: "assistant", content: response.content })
      toolResults = []
      for toolUse in response.tool_use_blocks:
        result = tools.execute(toolUse)  // observation
        toolResults.push({ type: "tool_result",
                           tool_use_id: toolUse.id,
                           content: result.content,
                           is_error: result.isError })
      messages.push({ role: "user", content: toolResults })
      turnCount += 1
    // hit max — return whatever partial state
    return partial
```

Diagram of the loop:

```
  ReAct loop — the kernel

  ┌────────────────────────────────────────────────────┐
  │  ┌─ Thought ─┐                                     │
  │  │  LLM text │  emitted as part of response        │
  │  └─────┬─────┘                                     │
  │        │                                            │
  │        ▼                                            │
  │  ┌─ Action ──┐                                     │
  │  │ tool_use  │  emitted as structured block        │
  │  └─────┬─────┘                                     │
  │        │  registry.execute()                        │
  │        ▼                                            │
  │  ┌─ Observation ┐                                  │
  │  │ tool_result  │  appended as user-role message   │
  │  └─────┬────────┘                                  │
  │        │                                            │
  │        └────────── back to next model turn ─────►  │
  └────────────────────────────────────────────────────┘

  stop when: model emits end_turn OR max_iterations hit
```

### Move 3 — the principle

Interleaving thought with action makes the loop debuggable. The thought text externalizes the model's reasoning; the action externalizes what it decided. Both are visible in the trace; both are inspectable in the receipts. If you strip thought (some agents run tools without emitting text), you save tokens but lose the interpretability.

## Primary diagram

```
  ReAct — full frame

  ┌─ Turn 1 ────────────────────────────────────────────────┐
  │                                                          │
  │  Thought:      "I need to check funnel per-step"          │
  │  Action:       execute_analytics_eql(eql="funnel by ...") │
  │  Observation:  { view: 100k, cart: 34k, ... }             │
  │                                                          │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ Turn 2 ────────────────────────────────────────────────┐
  │                                                          │
  │  Thought:      "Checkout stage lost most. Check           │
  │                 payment failures."                        │
  │  Action:       execute_analytics_eql(eql="payment_fail...")│
  │  Observation:  { current: 0.046, prior: 0.035 }           │
  │                                                          │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
                       ... loops ...
                          │
                          ▼
  ┌─ Terminal turn ─────────────────────────────────────────┐
  │                                                          │
  │  Thought:      "Payment processor is the primary cause"   │
  │  Action:       submit_diagnosis({ conclusion, ... })      │
  │  (no observation; agent stops)                            │
  │                                                          │
  └─────────────────────────────────────────────────────────┘

  User sees this in StatusLog live via NDJSON events.
  Receipts capture the full trace for post-hoc analysis.
```

## Elaborate

ReAct (Yao et al. 2022, "ReAct: Synergizing Reasoning and Acting in Language Models") is the specific pattern. Modern implementations (aptkit, LangChain, Anthropic's tool-use API) don't always follow the paper exactly — the shape has drifted to "any loop with tool calls and interleaved reasoning" — but the interleave-thought-with-action idea is what makes it "ReAct" rather than just "an agent loop."

The key insight from the original paper: reasoning about the next step *before* choosing the tool improves multi-step tasks. Skipping the reasoning (chain-of-tools without thoughts) tends to degrade quality on tasks that need planning.

Related: **01-agents-vs-chains.md** (ReAct is one specific shape of the agent kernel), **02-tool-calling.md** (the tool part of ReAct), **05-agent-memory.md** (memory adapts to the loop shape).

## Project exercises

### B4.3 · Force explicit "current best hypothesis" thoughts

- **Exercise ID:** B4.3 (Case A — ReAct loop is live; extend the prompt)
- **What to build:** Modify the diagnostic system prompt (via aptkit's config or a wrapper) to require every reasoning_step to end with "Current best hypothesis: ...". This weaponizes the ReAct trace against the lost-in-the-middle failure mode (see **../02-context-and-prompts/02-lost-in-the-middle.md**).
- **Why it earns its place:** Directly targets the recommendation-fit failure in cases 01 + 08. Measurable via baseline rerun.
- **Files to touch:** aptkit prompt override / addendum config, `lib/agents/diagnostic.ts`, receipt validation to confirm the line appears.
- **Done when:** every case's reasoning trace has the "Current best hypothesis" line; rerun of baseline shows recommendation-quality pass rate delta.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why interleave thought and action instead of just tool calls?**

Debuggability and steerability. The thought text externalizes what the model is planning to do; when the plan is wrong, the trace tells you why. Without the thought, you have a sequence of tool calls with no explanation — figure out the model's plan from the results alone. Load-bearing: at inference time, forcing the model to write out its thought before acting tends to keep it grounded (empirical result from the original paper).

**Q: What happens when the model just skips thoughts?**

Sometimes it does. Aptkit's system prompt requests explicit reasoning; some responses still come back as pure `tool_use` blocks with no text. Not a bug — just a signal that either the prompt could be firmer or the task was straightforward enough the model didn't need to plan. If it becomes a pattern (say, the trace loses interpretability), tightening the system prompt is the fix.

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — where ReAct sits as one loop shape.
- [02-tool-calling.md](02-tool-calling.md) — the action part.
- [../02-context-and-prompts/02-lost-in-the-middle.md](../02-context-and-prompts/02-lost-in-the-middle.md) — the failure the "current best hypothesis" exercise addresses.
