# 01 — agents vs chains

**Subtitle:** Loop vs pipeline · Industry standard (load-bearing for this codebase)

## Zoom out, then zoom in

blooming insights is *both*. The product is a **chain** at the top
(monitoring → diagnostic → recommendation; see
`02-context-and-prompts/03-prompt-chaining.md`). Inside each step is an
**agent loop** — the model decides which tools to call, how many turns to
take, when to stop. The chain is in Blooming; the loops are in AptKit.

```
  Zoom out — outer chain, inner loops

  ┌─ /api/agent route ──────────────────────────────────────┐
  │                                                         │
  │  diagnose step                                          │
  │    ┌─ DiagnosticAgent.investigate(anomaly) ──────────┐  │
  │    │  ┌─ AptKit DiagnosticInvestigationAgent loop ─┐ │  │  ← we are here
  │    │  │  while (not done) {                        │ │  │
  │    │  │    model decides → tool_use OR text       │ │  │
  │    │  │    if tool_use: run, append result        │ │  │
  │    │  │    if text: parse JSON, return            │ │  │
  │    │  │  }                                         │ │  │
  │    │  └────────────────────────────────────────────┘ │  │
  │    └──────────────────────────────────────────────────┘  │
  │                                                         │
  │  recommend step (next route call)                       │
  │    └─ same shape, RecommendationAgent.propose          │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — control flow ownership.** *Chain layer:* CODE
    decides which step runs next (the route's `if (step === 'recommend')`
    branch). *Loop layer:* LLM decides which tool to call next, when to
    stop. The axis FLIPS at the boundary between Blooming's route handler
    and AptKit's agent class.

  → **Two layers, one mechanism repeated:** at the outer level, "next step
    in the chain" is determined by a URL param + route logic. At the
    inner level, "next move in the loop" is determined by the model's
    next-token prediction. *Same shape (sequence of moves), different
    decider, different ownership.*

  → **The load-bearing seam:** the boundary between Blooming's
    `DiagnosticAgent.investigate()` and AptKit's
    `DiagnosticInvestigationAgent.investigate()`. Above: a single method
    call from a route handler. Below: an entire model loop with its own
    cancellation, error handling, and tool dispatch. Without this seam,
    Blooming would re-implement the loop in every agent file.

## How it works

### Move 1 — the mental model

You already know both shapes. A chain is `f().then(g).then(h)` — predicable
sequence, each step's output is the next step's input. An agent is a
`while (true) { ... }` — the LLM decides when to break.

```
  Chain (linear, predictable)

  Input → Step 1 → Step 2 → Step 3 → Output
   you defined the steps; LLM executes each one


  Agent (loop, variable count)

  Input → Thought → Action → Observation → Thought → … → Output
   LLM decides the steps AND when to stop


  THIS CODEBASE — both, nested:

   Chain LEVEL (Blooming owns):
     /api/briefing → monitoring chain step
     /api/agent?step=diagnose → diagnostic chain step
     /api/agent?step=recommend → recommendation chain step

   Loop LEVEL (AptKit owns, inside each chain step):
     Thought → tool_use → tool_result → … → final JSON
```

### Move 2 — the step-by-step walkthrough

**Step 1 — Blooming's chain step is a method call.**
`DiagnosticAgent.investigate()` (`lib/agents/diagnostic.ts:35-44`):

```typescript
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

This is the entire wrapper. Three things happen:
  1. Construct the AptKit agent with four injected adapters (model,
     tools, workspace context, trace).
  2. Call `agent.investigate(anomaly)` and await the diagnosis.
  3. Convert AptKit's diagnosis type to Blooming's diagnosis type
     (currently a passthrough — see `toBloomingDiagnosis` line 47).

**Step 2 — AptKit's loop is what actually runs.** Blooming doesn't see
the loop. It calls `agent.investigate()` and awaits the result. Inside
AptKit, the loop looks something like (pseudocode based on observed
behavior):

```
loop:
  request = build_model_request(history, system_prompt, tools)
  response = await modelProvider.complete(request)
  for each block in response.content:
    if block.type == 'text':
      traceSink.emit({type: 'step', content: block.text})
      // accumulate as a "thought" — appended to history as assistant message
    elif block.type == 'tool_use':
      traceSink.emit({type: 'tool_call_start', toolName, args, toolUseId})
      result = await toolRegistry.callTool(block.name, block.input, {signal})
      traceSink.emit({type: 'tool_call_end', toolName, durationMs, result})
      history.append(assistant: block)         // the tool_use
      history.append(user: tool_result(block.id, result))
  if response.stop_reason == 'end_turn' or no tool_use blocks:
    final_text = extract_text(response)
    parsed = parseAgentJson(final_text)
    if !isDiagnosis(parsed): retry or throw
    return parsed
```

**The three callbacks Blooming provides.** When AptKit calls the model
provider, tool registry, or trace sink, it's calling Blooming code:

  → `AnthropicModelProviderAdapter.complete(req)` — Blooming's bridge to
    the Anthropic SDK. AptKit doesn't know about Anthropic.
  → `BloomingToolRegistryAdapter.callTool(name, args, {signal})` —
    Blooming's bridge to `dataSource.callTool` (which is
    `BloomreachDataSource.callTool` in live mode). AptKit doesn't know
    about MCP or Bloomreach.
  → `BloomingTraceSinkAdapter.emit(event)` — Blooming's bridge to the
    NDJSON stream. AptKit emits `CapabilityEvent`s; Blooming converts
    them to `AgentEvent`s and writes them on the wire.

**Why the layering matters.** When the user navigates away mid-
investigation:

  - The browser's `fetch` request aborts.
  - The route handler's `req.signal.aborted` becomes true.
  - The agent loop's next `signal.throwIfAborted()` throws.
  - The throw propagates up through `agent.investigate`, through
    `complete()`'s pending `messages.create`, through
    `callTool`'s pending MCP request.
  - The route catches the AbortError, skips the error emission, and
    closes the stream.

This works because the cancellation signal threads through *both layers*:
the chain's `if (step === 'recommend')` doesn't run a new agent if
already aborted; the loop's per-turn `throwIfAborted` halts AptKit; the
adapter passes `signal` into the Anthropic SDK and MCP transport. One
signal, two layers, full cancellability.

### Move 2 variant — the load-bearing skeleton

The agent loop's irreducible kernel:

```
  loop:
    request  = (messages, system, tools)        ← grows per turn
    response = model(request)                   ← THE LLM CALL
    if response has tool_use:
      result  = run(tool)
      append (tool_use, tool_result) to messages
    else:
      return text                                ← TERMINATION
```

**What breaks when each part is missing:**

  → **No accumulator (`messages` not appended).** Each turn would see
    only the system prompt; the model loops forever requesting the same
    tool, never knowing it already ran.

  → **No tool dispatch.** The model emits a `tool_use` block; Blooming
    ignores it; the model never gets the data it asked for; it gives up
    or hallucinates.

  → **No termination check.** The model emits text (its final answer);
    Blooming treats it as another input; the loop never ends. AptKit
    detects this via `stop_reason: end_turn` OR absence of `tool_use`
    blocks.

  → **No hard iteration cap.** The model loops on the same tool
    indefinitely (rare but happens with confused prompts). AptKit
    enforces a max iteration count; Blooming's prompts add explicit
    tool-call caps ("at most 6 tool calls") as a softer earlier bound.

**Optional hardening (not in the kernel):** retry-with-backoff on
transient errors, observability hooks, cancellation signal threading,
token budget tracking. All exist in this codebase but aren't part of
the loop's reducible shape.

### Move 3 — the principle

**Use a chain when you know the steps in advance; use an agent loop when
the steps depend on what the model finds. Nest them — outer chain,
inner loops — when both are true.** That's exactly the shape blooming
insights uses: the *kinds* of work (detect / diagnose / recommend) are
known up front (chain); the *specific moves* within each kind depend on
the data (loop). The chain composes deterministically; the loops handle
the variability.

## Primary diagram

```
  Two layers, one mechanism — the chain-of-loops

  ┌─ Blooming chain layer (route handler) ──────────────────┐
  │  ┌─ CODE decides ────────────────────────────────────┐  │
  │  │  if (step === 'diagnose') runDiagnostic()         │  │
  │  │  if (step === 'recommend') runRecommendation()    │  │
  │  └────────────────────────────────────────────────────┘  │
  │                                                         │
  │  inside runDiagnostic:                                  │
  │    diagAgent.investigate(anomaly, {signal})             │
  │           │                                             │
  │           ▼                                             │
  │  ┌─ AptKit loop layer ──────────────────────────────┐  │
  │  │  ┌─ LLM decides ─────────────────────────────┐  │  │
  │  │  │  while (not done) {                       │  │  │
  │  │  │    model picks: tool_use or final text    │  │  │
  │  │  │    if tool_use: run, append result        │  │  │
  │  │  │    if text: parse, validate, return        │  │  │
  │  │  │  }                                         │  │  │
  │  │  └────────────────────────────────────────────┘  │  │
  │  │  callbacks back to Blooming:                     │  │
  │  │    modelProvider.complete(req)                   │  │
  │  │    toolRegistry.callTool(name, args)             │  │
  │  │    traceSink.emit(event)                         │  │
  │  └───────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────┘

  axis = "who decides what happens next?"
  chain layer:   CODE decides
  loop layer:    LLM decides
  flip happens at agent.investigate() boundary
```

## Elaborate

The chain-of-loops pattern is *the* dominant shape for production LLM
applications past toy scale. Pure chains are too rigid; pure agents are
too unpredictable. Nesting gives you the predictability where you need
it (chain ordering, eval boundaries) and flexibility where you need it
(within-step exploration).

LangChain's `AgentExecutor` and OpenAI's Assistants both implement the
loop layer. AptKit is in the same shape, with a smaller surface area
(no LangChain-style serialization, no graph orchestration, no callbacks
hierarchy — just the four-port `ModelProvider` / `ToolRegistry` /
workspace / `TraceSink` interface).

The decision to put the chain in Blooming and the loop in AptKit
reflects what's reusable. The loop logic is generic across products;
the chain composition is product-specific. Putting the loop in AptKit
means a second product (loopd, contrl-mo, etc.) can adopt the same
agent shapes by writing its own adapters + its own chain.

## Project exercises

### Exercise — emit `iteration_count` per loop on the trace

  → **Exercise ID:** `study-ai-eng-04-01.1`
  → **What to build:** Add an `iteration` counter to
    `BloomingTraceSinkAdapter` that increments on every `step` event
    (each text emission corresponds to one model turn). Emit a final
    `{ type: 'loop_done', iterations, agent }` event so the UI shows
    "investigated in 4 turns" per agent.
  → **Why it earns its place:** Makes the loop layer visible. Today
    iteration count is hidden — you only see tool calls + final
    diagnosis. Showing the turn count signals "this is a multi-turn
    loop" to anyone watching.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:100-130`,
    `lib/mcp/events.ts`, `components/investigation/ReasoningTrace.tsx`.
  → **Done when:** A live investigation surfaces "4 turns" in the
    diagnosis footer.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: Is blooming insights a chain or an agent?**

Both. The product is a chain at the top: **monitoring → diagnostic →
recommendation**, where the route handler owns the ordering. Inside each
step is an agent loop (AptKit owns it) where the model picks tools and
decides when to stop.

```
  Chain layer (Blooming): CODE decides which step runs
  Loop  layer (AptKit):   LLM decides which tool to call
                          and when to terminate

  axis "who decides the next move" flips at agent.investigate()
```

**Anchor line:** "Outer chain, inner loops. The chain is in the route
handler; the loops are in AptKit. The chain gives me predictable
ordering and clean eval boundaries; the loops give the model room to
explore within each step."

**Q: What's the load-bearing part of the loop layer people forget?**

The **terminating condition**. The kernel is: model picks tool_use →
run tool → append → repeat, UNTIL the model emits text instead of a
tool_use OR the iteration cap is hit. Drop the termination check and
the loop runs forever. The cap is the safety net; the model's natural
"I'm done" (no tool_use block) is the normal path. Both have to be
right.

**Anchor line:** "No termination = infinite loop. The model's text-only
turn is the normal stop; the hard iteration cap is the safety net."

**Q: Why is AptKit a separate library?**

The loop logic is generic across products. The model adapter, tool
registry, workspace context, trace sink — all four ports could be
reimplemented in a different product (loopd journaling, contrl-mo
fitness coaching) without changing the loop logic. Pulling the loop into
its own package makes that explicit. Blooming is one consumer of AptKit;
others can be added without coupling.

## See also

  → `02-tool-calling.md` — what one turn's tool_use → tool_result hop looks like
  → `02-context-and-prompts/03-prompt-chaining.md` — the OUTER chain layer
  → `06-error-recovery.md` — what happens when a tool call fails mid-loop
