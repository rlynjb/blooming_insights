# 03 — ReAct pattern

**Subtitle:** Thought / Action / Observation interleaving · Industry standard

## Zoom out, then zoom in

ReAct (Yao et al., 2022) is the interleaving pattern that makes the
agent loop debuggable: the model emits a *thought* (free-form text
explaining its reasoning), then an *action* (a tool call), then receives
an *observation* (the tool result), then another thought, until done.
AptKit's agent loop is ReAct-shaped; the trace shows it directly.

```
  Zoom out — ReAct is the pattern WITHIN one agent loop

  ┌─ Diagnostic agent loop (AptKit) ───────────────────────┐
  │                                                        │
  │  Thought:    "Conversion dropped 30%. Let me check     │  ← we are here
  │               which device type is responsible."       │   (the trace
  │  Action:     execute_analytics_eql(by device)          │    surface)
  │  Observation: { mobile: -50%, desktop: -5% }           │
  │                                                        │
  │  Thought:    "Mobile is the cause. Let me check        │
  │               campaigns targeting mobile."             │
  │  Action:     list_email_campaigns(filter=mobile)       │
  │  Observation: { campaigns: [{id: ..., sent_to: mob}] } │
  │                                                        │
  │  Thought:    "Found it — campaign 7 broke the funnel"  │
  │  Final:      Diagnosis JSON                             │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — externalization.** Each thought makes the
    model's *reasoning* visible to your code, your trace, your eval. A
    bad reasoning trace points to a prompt bug; a good trace that ended
    in the wrong answer points to a model bug. Without ReAct, you only
    see the final answer and have no debugging surface.

## How it works

### Move 1 — the mental model

You've debugged code with print statements at every step: `console.log
('checking input'); console.log('result:', x); console.log('next step')`.
ReAct is the same shape, except the model prints its own reasoning.

```
  ReAct interleaving (one investigation, six turns)

  Thought 1:    "Need to find which device is causing the drop"
  Action 1:     execute_analytics_eql(by device_type)
  Observation 1: { mobile: -50%, desktop: -5%, tablet: -10% }

  Thought 2:    "Mobile is the cause. Check what changed for mobile."
  Action 2:     execute_analytics_eql(mobile checkout funnel by day)
  Observation 2: { day 1-5: normal, day 6+: 50% drop in checkout step }

  Thought 3:    "Day 6 onward. Check what campaign launched."
  Action 3:     list_email_campaigns(launched after day 6, mobile)
  Observation 3: [{ id: 'camp7', launch: day 6, targeting: mobile }]

  Final:        Diagnosis JSON {
                  conclusion: "campaign 7 launched day 6 broke mobile checkout",
                  evidence: ["...", "..."],
                  hypothesesConsidered: [...],
                  affectedCustomers: { count: ~50k, segment: "mobile" }
                }
```

### Move 2 — the step-by-step walkthrough

**Where the thought lives in this codebase.** In Anthropic's `tool_use`
flow, "thought" is any text content block emitted in the same response
as a `tool_use` block (or just before one). It's prose the model writes
about what it's doing.

In Blooming's adapter, text blocks become `step` events via the trace
sink (`lib/agents/aptkit-adapters.ts:109-112`):

```typescript
if (event.type === 'step') {
  this.hooks.onText?.(event.content);
  return;
}
```

The route's `hooksFor()` converts these to `reasoning_step` events on
the NDJSON wire:

```typescript
onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },
```

Each thought becomes a line in the StatusLog UI, tagged with the agent
name and timestamp.

**Where the action lives.** Same response as the thought, but a
`tool_use` block instead of (or alongside) the text. The
`BloomingToolRegistryAdapter.callTool` dispatches; the trace emits
`tool_call_start` / `tool_call_end` events.

**Where the observation lives.** The tool result, passed back to AptKit
as the next user message's `tool_result` content block. The trace shows
the result inline:

```typescript
onToolResult: (tc: ToolCall) => send({
  type: 'tool_call_end',
  toolName: tc.toolName,
  agent,
  durationMs: tc.durationMs ?? 0,
  result: trunc(tc.result),    // ← truncated for the wire
  error: tc.error,
}),
```

The UI's `ToolCallBlock` component shows the tool name, duration, and
an expandable JSON result — that's the observation made visible.

**Why this pattern is debuggable.** When an investigation produces a
wrong diagnosis, you can scroll back through the trace and see:

  - *Did the model think the right thought?* (If thought 1 was "let me
    check pricing" when the right move was "let me check devices," the
    prompt is steering wrong.)
  - *Did the right tool get called?* (If thought said "check devices"
    but action called a campaign tool, the model has a prompt bug.)
  - *Did the tool return the right data?* (If the observation was an
    empty result, the EQL query was wrong — separate problem.)
  - *Did the model interpret the observation correctly?* (If the next
    thought ignored the data, the model has an attention bug.)

Without the interleaved trace, you'd see only the final diagnosis and
have to guess where it went wrong.

**The pattern in this codebase's prompts.** The monitoring prompt
explicitly structures the model's behavior in ReAct shape — see
`lib/agents/legacy-prompts/monitoring.md`, the "Suggested query plan"
section, which walks the model through 5 expected actions. The model
mostly follows it, emitting brief thoughts before each query and a
final synthesis. Same for diagnostic ("Investigation approach: 1.
Generate 2–3 hypotheses BEFORE your first tool call…").

### Move 3 — the principle

**Force the model to externalize its reasoning between actions, so the
trace becomes your debugging surface.** Without ReAct, when something
goes wrong you have a final answer and no way to know where the
reasoning broke. With ReAct, the trace tells you which turn the model
made the wrong move. The cost is more output tokens (the thoughts
aren't free) and slightly slower loops; the benefit is debuggability.

## Primary diagram

```
  ReAct in this codebase — what each block becomes on the wire

  ┌─ Anthropic response ──────────────┐
  │  content: [                       │
  │    {type: 'text', text: 'thought'},  ← reasoning_step (thought)
  │    {type: 'tool_use', name, input},  ← tool_call_start
  │  ]                                │
  └─────────────┬─────────────────────┘
                │
                ▼  AptKit runs tool
                │
                ▼
  ┌─ tool result ─────────────────────┐
  │  AptKit prepends to next turn's   │  ← tool_call_end
  │  messages as tool_result block    │     (observation in UI)
  └─────────────┬─────────────────────┘
                │
                ▼  next turn
  ┌─ Anthropic response ──────────────┐
  │  content: [                       │
  │    {type: 'text', text: 'next thought'},
  │    {type: 'tool_use'},            │
  │  ]                                │
  └─────────────┬─────────────────────┘
                ⋯ repeat until model emits text-only (final answer)

  Final turn:
  ┌─ Anthropic response ──────────────┐
  │  content: [                       │
  │    {type: 'text', text: 'JSON: …'} │  ← parsed by parseAgentJson,
  │  ]                                │     validated by isDiagnosis
  └────────────────────────────────────┘
```

## Elaborate

ReAct was introduced in 2022 (Yao et al., "ReAct: Synergizing Reasoning
and Acting in Language Models"). Before ReAct, agent papers either had
the model emit pure actions (no reasoning visible — hard to debug) or
pure reasoning chains (no actions — couldn't interact with tools).
Interleaving both turned out to dramatically improve both interpretability
AND task performance.

The pattern is now baked into every modern tool-using LLM — Anthropic's
`tool_use` format encourages it (the model naturally emits text
alongside tool calls), OpenAI's function calling supports it via
`tool_calls` + content text. AptKit doesn't have to do anything special
to enable ReAct; just expose tools and the model emits the pattern.

For this codebase's debuggability, ReAct is the reason the StatusLog UI
exists. Without externalized thoughts, the panel would just be "tool
call 1, tool call 2, tool call 3, done." With thoughts, you see the
model's narrative — "monitoring agent: scanning revenue / conversion /
traffic; revenue drop detected, computing impact estimate; classifying
as critical." That narrative is the product's *trustworthiness signal*.

## Project exercises

### Exercise — add hypothesis-tagging to diagnostic thoughts

  → **Exercise ID:** `study-ai-eng-04-03.1`
  → **What to build:** Modify the diagnostic prompt to require each
    thought to be tagged with the hypothesis it's testing (e.g.
    "Hypothesis 1 (device cause): checking…"). Parse the tags in
    `hooksFor()` and emit a structured `{ type: 'reasoning_step', kind:
    'hypothesis', tag: 'H1', content }` event. UI renders hypothesis-
    tagged thoughts grouped.
  → **Why it earns its place:** Makes the model's hypothesis testing
    structurally visible — debuggable per hypothesis, not as a flat
    sequence.
  → **Files to touch:** `lib/agents/legacy-prompts/diagnostic.md`,
    `lib/mcp/events.ts` (extend reasoning_step), route's `hooksFor`,
    `components/investigation/ReasoningTrace.tsx`.
  → **Done when:** UI shows "H1: device cause (3 thoughts) / H2: campaign
    cause (2 thoughts) / H3: pricing cause (1 thought)" grouping.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: How does the agent's reasoning surface in the UI?**

Through the ReAct interleaving. Each model turn emits a thought (text
content block) and an action (`tool_use` block). The thought becomes a
`reasoning_step` event on the NDJSON wire; the action becomes a
`tool_call_start` event. The result of running the tool becomes a
`tool_call_end` event with the data. The StatusLog renders all of them
in timestamp order — so the user sees the model's narrative, not just
the final answer.

```
  trace shows:
    "monitoring agent: scanning revenue, conversion, traffic"  ← thought
    [tool: execute_analytics_eql ✓ 1.2s]                       ← action+obs
    "found revenue down 30% — classifying as critical"         ← thought
    ...
    "[10 anomalies emitted]"                                    ← final
```

**Anchor line:** "ReAct makes the model debuggable. The thoughts are
the debugging surface — without them, you have a final answer and no
way to know where reasoning broke."

**Q: What's the load-bearing thing about ReAct people forget?**

It costs output tokens. The thoughts aren't free — each turn pays for
"~50-200 tokens of model talking about what it's doing." For high-
volume systems that's real money. The tradeoff is debuggability vs cost;
this codebase pays the cost because the trace IS part of the product
("an analyst that shows its work").

For a backend-only agent where nobody reads the trace, you could prompt
the model to emit *less* thought between actions. Saves tokens, costs
debuggability.

## See also

  → `01-agents-vs-chains.md` — the loop ReAct happens inside
  → `02-tool-calling.md` — the action half of the pattern
  → `05-evals-and-observability/04-llm-observability.md` — how thoughts
    feed observability
