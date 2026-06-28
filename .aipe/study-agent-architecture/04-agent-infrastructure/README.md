# 04 · Agent infrastructure

The cross-cutting disciplines that matter more than any single topology — the parts most practitioners underweight and the parts that separate a demo from a shipped system.

## Files

1. [`01-context-engineering.md`](./01-context-engineering.md) — the discipline RAG and prompt engineering are subsets of; this repo's schema-gated category list IS context engineering in action
2. [`02-agent-memory-tiers.md`](./02-agent-memory-tiers.md) — working / episodic / long-term; this repo has only working (in-context) plus a thin episodic cache for replay
3. [`03-tool-calling-and-mcp.md`](./03-tool-calling-and-mcp.md) — tool calling is the substrate every pattern in this guide runs on; MCP is THE protocol this repo uses
4. [`04-agent-evaluation.md`](./04-agent-evaluation.md) — trajectory eval is harder than output eval; in this repo, the streamed AgentEvent NDJSON trace IS the eval surface (no automated harness)
5. [`05-guardrails-and-control.md`](./05-guardrails-and-control.md) — the control envelope around an autonomous loop; this repo's envelope is per-agent budgets + AbortSignal + AptKit validators

## How this maps to the codebase

| File | In this codebase? |
|---|---|
| Context engineering | **Yes — load-bearing.** Schema-gated category list (`lib/agents/categories.ts`), `schemaSummary` capped at 20 events × 10 props, message-passing-not-blackboard between agents. |
| Agent memory tiers | **Partial.** Working memory (in-context) only. Thin episodic cache for replay (`lib/state/investigations.ts`). No long-term, no embeddings, no cross-session retrieval. |
| Tool calling and MCP | **Yes — load-bearing.** All tools come from `@modelcontextprotocol/sdk` over the Bloomreach MCP server. Per-agent tool policies enforced by AptKit. |
| Agent evaluation | **Partial — by reading.** The streamed `AgentEvent` NDJSON contract IS the inspectable trajectory. No automated trajectory-eval harness in the repo (the `eval/` pipeline was removed). |
| Guardrails and control | **Yes — load-bearing.** Per-agent `maxTurns + maxToolCalls + forced-final synthesis` (kernel), AbortSignal threaded through every async layer (route → AptKit → Anthropic + MCP), AptKit output validators, action-gating split (the user reviews diagnosis before recommendations run). |
