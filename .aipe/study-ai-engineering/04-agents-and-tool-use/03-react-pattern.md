# 03 — ReAct pattern

**Type:** Industry standard. Also called: Reason + Act, Thought-Action-Observation.

## Zoom out, then zoom in

The loop shape every agent in this codebase runs. Interleaved reasoning and tool use. The model narrates what it's about to do, does it (via tool_use), reads the result, narrates again.

```
  Zoom out — where the loop runs

  ┌─ Agent (DiagnosticInvestigationAgent, AptKit) ────────────────────┐
  │                                                                   │
  │   Thought (text block)                                            │
  │      │                                                            │
  │      ▼                                                            │
  │   Action (tool_use block) ← ★ THIS CONCEPT — the loop ★           │
  │      │                                                            │
  │      ▼                                                            │
  │   Observation (tool_result on next turn)                          │
  │      │                                                            │
  │      ▼                                                            │
  │   Thought → Action → Observation → ...                            │
  │      │                                                            │
  │      ▼                                                            │
  │   Conclusion (tool_use → submitDiagnosis)                         │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. ReAct = the pattern of forcing the model to externalize reasoning between actions. The model's `text` blocks (reasoning) and `tool_use` blocks (action) interleave. Each observation (`tool_result`) informs the next thought. In this codebase, the streamed `reasoning_step` events ARE the ReAct thoughts — visible in the UI's `StatusLog`.

## Structure pass

**Layers:**
- Outer: one full investigation (10-15 turns end-to-end)
- Middle: one T→A→O cycle (~3 model turns and 1 tool call)
- Inner: individual content blocks (text, tool_use, tool_result)

**Axis: what drives the next iteration?**
- The last observation (tool_result content) informs the next thought
- If observation supports the current hypothesis: pursue it
- If observation contradicts: pivot to a different hypothesis
- If enough evidence: submit conclusion (final tool_use)

**Seam:** the model → tool → model boundary. Every T→A→O crosses it twice (once for the tool_use, once for the tool_result in the next model call).

## How it works

### Move 1 — the mental model

You've debugged with a REPL — think, try, observe the result, refine, try again. Same shape at LLM scale. The model narrates aloud between actions, which makes the reasoning inspectable AND makes the model itself more accurate (research finding: interleaving reasoning with actions beats reasoning-then-acting or acting-then-reasoning).

```
  Thought → Action → Observation, repeated

    Thought 1: "I need to check payment_failure rates for the same window."
    Action 1:  execute_analytics_eql(query: "select count event payment_failure by day…")
    Observation 1: {counts: [...], total: 2360}
       │
       ▼ ← informs next thought
    Thought 2: "Payment failures up 31%. Now check the funnel to see if
                other steps are stable."
    Action 2: execute_analytics_eql(query: "select count event view_item, …")
    Observation 2: {view: 100000, cart: 34200, ...}
       │
       ▼
    ... continues until enough evidence, then...
    Final Action: submitDiagnosis({conclusion: "...", evidence: [...]})
```

### Move 2 — walk the mechanism

**The loop, once per turn.**

AptKit's loop (simplified from `@aptkit/core`):

```
  while (turnsRemaining > 0) {
    response = await model.complete({messages, tools});
    messages.push({role: 'assistant', content: response.content});

    for (const block of response.content) {
      if (block.type === 'text') {
        trace.emit({type: 'step', content: block.text});
        // hooks.onText fires → NDJSON reasoning_step event
      }

      if (block.type === 'tool_use') {
        if (block.name === 'submitDiagnosis') {
          return block.input as Diagnosis;
        }
        result = await tools.callTool(block.name, block.input);
        // hooks.onToolCall / onToolResult fire → NDJSON tool_call_* events
        pending.push({tool_use_id: block.id, result});
      }
    }

    // build the next user message from all tool_results
    if (pending.length > 0) {
      messages.push({role: 'user', content: pending.map(p => ({
        type: 'tool_result',
        tool_use_id: p.tool_use_id,
        content: JSON.stringify(p.result),
      }))});
    }
    turnsRemaining--;
  }
```

**What each block does.**

- `text` block: the model's reasoning. Streamed as `reasoning_step` NDJSON event to the UI. Not consumed by the loop for decisions — it's for humans (and for future turns of the model, since it's in the messages array).
- `tool_use` block: the model's action. AptKit dispatches to the tool registry, gets the result, packages it as the next `tool_result`.
- `tool_result` (next turn's user message): the observation. Content is the JSON-stringified tool output. On next model turn, this becomes part of the input the model reasons over.

**The `submitDiagnosis` / `submitRecommendations` special tool.**

AptKit's agents register a special "submit" tool whose input schema IS the return type. When the model calls it, the loop treats that as the end signal, extracts `tool_use.input` as the typed answer, and returns. That's why the return from `DiagnosticAgent.investigate()` is a typed `Diagnosis` — the return path is a tool_use, not free text.

**The 6-tool-call soft cap.**

From the retired diagnostic prompt (`lib/agents/legacy-prompts/diagnostic.md:11`): "Make at most 6 tool calls, then conclude." AptKit's built-in prompt has a similar bound. This isn't a hard cap in the loop code (which would raise on turn N regardless of state) — it's a soft cap the model respects. Hard-cap-in-code exists too (AptKit's `turnsRemaining` counter), but it's much higher (~15-20) so it never fires in normal operation.

**Traced to the UI.**

Every T (text block) → `reasoning_step` event. Every A (tool_use) → `tool_call_start` event. Every O (tool_result on next turn) → `tool_call_end` event. That's what the `StatusLog` renders live. See `05-streaming.md` for the NDJSON wire.

### Move 3 — the principle

Forcing the model to externalize reasoning between actions has two benefits: (1) it makes the reasoning inspectable (which is the product's whole pitch — "an analyst that shows its work"), and (2) it measurably improves the quality of the actions themselves (models do better when they think aloud). ReAct captures both — the loop shape IS the debuggability AND the accuracy improvement.

## Primary diagram

Full ReAct loop over one investigation, from turn 1 to submit.

```
  ReAct — one diagnostic investigation

  turn 1  ┌──────────────────────────────────────────────────────────┐
          │  system + user(anomaly)                                   │
          │  → model                                                  │
          │  ← thought 1: "I need to check payment failures…"          │
          │  ← tool_use 1: execute_analytics_eql(query="…")            │
          └──────────────────────────────────────────────────────────┘

  loop dispatches tool_use → BloomingToolRegistryAdapter → DataSource

  turn 2  ┌──────────────────────────────────────────────────────────┐
          │  … + assistant(t1 + tu1) + user(tool_result 1)             │
          │  → model                                                  │
          │  ← thought 2: "Payment failures up 31%. Check funnel."     │
          │  ← tool_use 2: execute_analytics_eql(query="…funnel…")     │
          └──────────────────────────────────────────────────────────┘

  loop dispatches ...

  turn 3-6: similar T→A→O cycles

  turn 7  ┌──────────────────────────────────────────────────────────┐
          │  … + full history                                          │
          │  → model                                                  │
          │  ← thought 7: "Enough evidence. Submitting conclusion."    │
          │  ← tool_use 7: submitDiagnosis({conclusion: "…"})          │
          └──────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                             return typed Diagnosis
```

## Elaborate

ReAct comes from the 2022 paper "ReAct: Synergizing Reasoning and Acting in Language Models" (Yao et al.). The finding: interleaving reasoning and action produces higher-quality tool use than reasoning-then-acting or acting-then-reasoning. The paper's mechanism (text-prefixed action) predates native tool calling; modern implementations use tool_use blocks, but the pattern is the same.

Adjacent patterns: **Chain-of-Thought** (reasoning without action, single-turn), **Tree-of-Thoughts** (branch-and-evaluate reasoning), **Reflection** (agent critiques its own output between turns). ReAct is the load-bearing one for tool-using agents.

## Project exercises

### Exercise — surface hypothesis pivots in the trace

- **Exercise ID:** C4.3-A · Case A (concept exercised).
- **What to build:** parse each reasoning_step's content for hypothesis pivots — sentences that mention a NEW hypothesis after already discussing another. Emit as a distinct `hypothesis_pivot` NDJSON event; render prominently in `StatusLog`. Makes the ReAct loop's reasoning STRUCTURE visible, not just its content.
- **Why it earns its place:** turns the trace from prose narration into a structured reasoning graph. Interviewer signal: "I don't just stream the model's reasoning; I structure it into pivots and evidence."
- **Files to touch:** `lib/mcp/events.ts` (new event kind), `lib/agents/aptkit-adapters.ts` (parse in TraceSinkAdapter), `components/investigation/ReasoningTrace.tsx` (render pivots).
- **Done when:** running a diagnostic on golden 05 (no-signal) shows the "pivoted to hypothesis B → gave up" moment as a distinct trace item.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What does ReAct give you over "just reason then act"?**

Two things. Interleaved reasoning lets each action be informed by the previous observation — reasoning is REACTIVE, not planned in advance. And it's inspectable — every "thought" is a text block that streams to the UI as a `reasoning_step` event, so the user sees WHY each tool was called, not just that it was.

**Q: Where's the loop implemented?**

`@aptkit/core`'s `DiagnosticInvestigationAgent.investigate()`. My repo owns three adapters that plug into it — `AnthropicModelProviderAdapter` (the model call), `BloomingToolRegistryAdapter` (the tool dispatch), `BloomingTraceSinkAdapter` (the trace events). The loop itself is AptKit code; the parts around it are mine.

```
  AptKit owns:   the loop
  This repo owns: model provider, tool registry, trace sink
```

**Q: What signals loop termination?**

The model emits the `submitDiagnosis` tool_use (or `submitRecommendations` for the recommendation agent). AptKit's loop checks tool_use.name, and if it's the submit tool, extracts the input and returns instead of continuing to iterate. Alternatively: the loop's hard cap (`turnsRemaining`) hits zero — that's an error path that rarely fires.

## See also

- `01-agents-vs-chains.md` — the shape distinction
- `02-tool-calling.md` — the tool_use mechanism this loop uses
- `05-streaming.md` — how the T/A/O events reach the UI
- `06-error-recovery.md` — what happens when an observation is `isError`
