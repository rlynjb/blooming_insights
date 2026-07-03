# 04 — Agents and tool use

The load-bearing sub-section for this codebase. Every AI feature here is an agent in the ReAct-shape sense — a loop around an LLM + tools, running until the model concludes. AptKit (`@aptkit/core@0.3.0`) owns the loop; this repo owns the adapter bridge.

## Files (read in order)

- `01-agents-vs-chains.md` — the shape distinction. This repo has both — chains between agents (diagnose → recommend) AND ReAct loops within each.
- `02-tool-calling.md` — the tool_use / tool_result mechanism. The `BloomingToolRegistryAdapter` is where AptKit's tool contract meets Bloomreach MCP tools.
- `03-react-pattern.md` — thought → action → observation. What every agent in this repo runs internally.
- `04-tool-routing.md` — how the model decides which tool. Combined with the 6-tool-call cap.
- `05-agent-memory.md` — short-term (messages array) vs long-term (session storage, demo snapshot). No RAG-based long-term memory.
- `06-error-recovery.md` — the failure modes AptKit's loop handles: is_error tool_result, timeout, rate limit. The FaultInjectingDataSource proves it.

## Anchor shape

LLM application engineering. Every file directly exercised in this codebase.

## Curriculum

Phase 4 — concepts C4.1-C4.12.
