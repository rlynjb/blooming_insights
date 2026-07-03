# RFC-06 — AptKit primitives + Blooming adapter boundary

**Decision in one line:** Adopt `@aptkit/core@0.3.0` as the ReAct-loop library. Blooming keeps three thin adapters (`lib/agents/aptkit-adapters.ts`, 263 LOC) that bridge Anthropic + DataSource + trace hooks into AptKit's provider-neutral shapes. The library owns the loop; Blooming owns the boundary.

---

## Context

The original agent loop lived in `lib/agents/base.ts` — a hand-rolled `while (!done) { model.call() → parse content → dispatch tool_use / tool_result → append to messages }` loop. It worked, but it did four things simultaneously:

- Managed the ReAct message thread (system + assistant + tool_result blocks)
- Spoke Anthropic-specific vocabulary (`content: ContentBlock[]`, `usage.input_tokens`, `stop_reason`)
- Emitted Blooming's own trace events (`ReasoningStep`, `ToolCall`, `reasoning_step` NDJSON)
- Enforced tool-schema shape (MCP-flavored `inputSchema`)

Every new capability meant threading new state through the same function. Adding budget tracking meant one more parameter and one more check. Adding capability-event forwarding meant one more callback. The loop was becoming the place changes went to die.

AptKit exists to be that loop for you. It defines `ModelProvider` (the LLM abstraction), `ToolRegistry` (the tool-call abstraction), and `CapabilityTraceSink` (the observability abstraction), then runs the ReAct thread against those interfaces. If Blooming can express its Anthropic client + DataSource + trace events as those three interfaces, the loop becomes library code.

---

## Decision

Adopt AptKit for the loop. Write three adapter classes at `lib/agents/aptkit-adapters.ts` that bridge Blooming's existing primitives into AptKit's interfaces. Keep the old loop at `base-legacy.ts` as a rollback receipt.

```
The adapter boundary — where Blooming meets AptKit

  ┌─ Blooming side ──────────────────────┬─ Adapter ──────────────────────────┐
  │ Anthropic SDK                        │ AnthropicModelProviderAdapter       │
  │ (messages.create, usage.input_tokens)│  → implements ModelProvider        │
  │                                      │  ← ModelRequest, ModelResponse      │
  ├──────────────────────────────────────┼─────────────────────────────────────┤
  │ DataSource port + McpToolDef[]        │ BloomingToolRegistryAdapter         │
  │ (RFC-05: callTool, listTools)         │  → implements ToolRegistry          │
  │                                      │  ← ToolDefinition, tool-call result │
  ├──────────────────────────────────────┼─────────────────────────────────────┤
  │ Blooming trace hooks                 │ BloomingTraceSinkAdapter            │
  │ (onToolCall, onToolResult, onText)   │  → implements CapabilityTraceSink   │
  │                                      │  ← CapabilityEvent                  │
  └──────────────────────────────────────┴─────────────────────────────────────┘

  the loop that runs inside AptKit
  ┌────────────────────────────────────────────────────────────────┐
  │  request = { system, messages, tools }                          │
  │  while not done:                                                │
  │     response = modelProvider.complete(request)                  │  ← ours
  │     for each tool_use in response:                              │
  │        result = toolRegistry.callTool(name, args)               │  ← ours
  │        traceSink.emit(tool_call_start / tool_call_end)          │  ← ours
  │        append tool_result to request.messages                    │
  │  return final assistant text                                    │
  └────────────────────────────────────────────────────────────────┘
```

The boundary is exactly one file. Every agent (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`, `intent.ts`) constructs its three adapters, hands them to AptKit, and reads the final message when the loop terminates. Blooming's `AgentHooks` type still exists — the sink adapter translates AptKit's `CapabilityEvent` back into `onToolCall` / `onToolResult` / `onText` callbacks so the route handlers keep their existing NDJSON producers.

The legacy loop is preserved at `lib/agents/base-legacy.ts` (plus the `*-legacy.ts` sibling files for each agent). Not dead code — a rollback receipt. If AptKit's next release breaks the contract, the diff to fall back is `git revert` + a router change.

---

## Alternatives considered

**(a) Keep the hand-rolled loop, bolt on features.** The path of no library dependency. Loses because every feature added to that loop (budget tracking, capability events, prompt caching) was another parameter, another callback, another branch. AptKit turns those from "extra state in the loop" into "extra decorators on the adapter" — the loop stops being the growth point.

**(b) LangChain / LangGraph.** The obvious market-leader alternative. Loses on two axes. First, its abstractions are too wide — `Runnable`, `Chain`, `Agent`, `AgentExecutor`, `Tool`, `Memory` — most of which don't map cleanly onto the three-concept model here. Second, its opinions about state and memory conflict with Blooming's per-investigation session-keyed model (RFC-01). Blooming would have to adapt to LangChain's memory abstractions instead of the other way around. AptKit is narrower and matches the actual shape.

**(c) Anthropic's own tool-use loop from the SDK docs.** Copy-paste the "run this tool loop" example from the Anthropic cookbook. Loses because it IS the hand-rolled loop, just named differently. It's a starting point, not a library. No trace sink, no provider abstraction, no reusable structure — you'd be back to the same growth problem in a month.

---

## Consequences

**What this buys:**
- **The loop is library code now.** When AptKit fixes a ReAct edge case (e.g. handling a model that emits text alongside tool_use), Blooming inherits the fix by bumping the version.
- **The boundary is 263 lines and one file.** Not spread across five agents, not tangled with route handlers. Anyone auditing "how does Blooming talk to the loop?" opens `aptkit-adapters.ts` and sees everything at once.
- **Composable observability.** The `BloomingTraceSinkAdapter` forwards raw `CapabilityEvent`s to an optional `onCapabilityEvent` hook AND translates them into the existing per-type callbacks. New consumers (like the token+cost ledger) subscribe to the raw stream; old consumers (the route handlers) keep working. Additive, not breaking.
- **Provider-swap is theoretically free.** AptKit's `ModelProvider` isn't Anthropic-specific. Swapping to a different LLM vendor would be one new adapter class implementing `ModelProvider`, not a rewrite of the agents. Untested — but the shape is there.

**What it costs:**
- **A dependency at v0.3.0.** AptKit is early. Breaking changes in v0.4 / v0.5 are likely. The `*-legacy.ts` files exist precisely so a bad upgrade doesn't stall a release — but the ongoing tax is version-diff review on each bump.
- **The boundary needs to stay clean.** Every time a feature is tempted to reach around the port ("we'll access AptKit's internal message list directly for this one thing"), the boundary decays. The prompt-cache addition (RFC-09) sat cleanly inside the `AnthropicModelProviderAdapter.complete()` method — that's the shape to preserve. The budget check (RFC-07) did too. These are the tests the discipline has to keep passing.
- **Legacy sibling files are visual noise.** `base-legacy.ts`, `diagnostic-legacy.ts`, `monitoring-legacy.ts`, etc., all sit in `lib/agents/` next to the current ones. Anyone opening the directory sees them and needs to know why. Documented in the file headers; the CI ensures they don't get imported by active code.

**What the reviewer will push on:**
> "You added a dependency to do what a while loop already did."

Own it. The answer: the while loop worked when it did one thing. It stopped working when it had to do four things simultaneously and every new feature widened it. The library moves the growth point off the loop and onto the boundary, where the boundary is a bounded surface — three interfaces, one file, 263 lines. That's the trade. The legacy loop is still in the repo, so if the trade doesn't pay off, the rollback is short.

---

## Open questions

- **When to remove `*-legacy.ts`.** Currently kept as a rollback receipt. Real threshold: two consecutive AptKit minor versions without a breaking change AND one full week of live traffic on the AptKit-backed path without a rollback event. Not there yet.
- **`summarizeUsage` and cache tokens.** AptKit's usage summarizer doesn't yet know about `cache_creation_input_tokens` / `cache_read_input_tokens` — so the per-invocation cost estimate (visible in the budget tracker, RFC-07) undercounts the cache-read savings. Either patch upstream or add a Blooming-side correction in the adapter. Deferred pending an AptKit issue.
- **Multi-provider support.** Provider-swap is theoretically free (see above). Making it actually free means removing every "Anthropic-shaped assumption" that's still leaking through the adapter — the max_tokens default, the message format, the tool schema JSON shape. Real work when a second provider ships; noise until then.
