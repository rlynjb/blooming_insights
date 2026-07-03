# Section D — Agent infrastructure

**Anchor:** single-agent + multi-agent (both). The cross-cutting disciplines that matter more than any single topology.

Context engineering, memory, tool calling, guardrails, observability. Blooming exercises four of these five in production; agent evaluation lives adjacent (`eval/` harness) and gets its own file.

## Files

1. **`01-context-engineering.md`** — the discipline. What goes in every agent's window: system prompt, schemaSummary, tools, past turns.
2. **`02-agent-memory-tiers.md`** — working memory only (in-context). No episodic, no long-term. Where each would go if adopted.
3. **`03-tool-calling-and-mcp.md`** — the connective tissue. MCP as the protocol; BloomingToolRegistryAdapter as the aptkit ToolRegistry bridge.
4. **`04-guardrails-and-control.md`** — the control envelope. BudgetTracker + BudgetExceededError, type guards, iteration caps, cancellation via AbortSignal.
5. **`05-observability-hook.md`** — `onCapabilityEvent` — the additive hook that captures every raw AptKit trace event.

## Reading order

01 → 03 → 04 → 05 → 02. Context engineering first (it sets the stage); tool calling and guardrails next (they operate on context); observability captures everything; memory tiers close by naming what's NOT here.
