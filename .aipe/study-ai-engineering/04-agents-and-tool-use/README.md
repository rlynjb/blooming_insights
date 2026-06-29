# 04 — Agents and tool use

The discipline this codebase exercises the most. Five agents, one ReAct loop (inside `@aptkit/core`), three-class adapter bridge (`lib/agents/aptkit-adapters.ts`), 13-17 MCP tools per agent, structured trace stream, intent-based routing, error recovery delegated to the library.

The load-bearing pattern is the **three-port adapter boundary**: `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. The library owns the loop; this repo owns the boundary. 206 LOC of adapter code is the entire "agent runtime" surface in this codebase.

## Reading order

1. `01-agents-vs-chains.md` — agents (open-ended loop) vs chains (fixed steps); this codebase has both
2. `02-tool-calling.md` — the tool surface: MCP tools, allowlist filtering, schema-on-the-wire
3. `03-react-pattern.md` — the ReAct loop the AptKit agents implement under the hood
4. `04-tool-routing.md` — how intent classification + per-agent allowlists route work
5. `05-agent-memory.md` — the diagnose → recommend handoff is the only memory between turns
6. `06-error-recovery.md` — what happens when tools fail, agents loop, or budgets blow
