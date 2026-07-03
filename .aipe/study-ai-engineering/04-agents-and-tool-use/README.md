# 04 · Agents and tool use

Where most of blooming_insights lives. Five agent classes wrapping `@aptkit/core` primitives, one tool-registry seam, and a real production ReAct loop.

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the shape difference and how blooming uses both.
- [02-tool-calling.md](02-tool-calling.md) — the tool_use / tool_result loop.
- [03-react-pattern.md](03-react-pattern.md) — the Thought / Action / Observation trace at the heart of every agent.
- [04-tool-routing.md](04-tool-routing.md) — the coverage gate + intent classifier as tool-selection heuristics.
- [05-agent-memory.md](05-agent-memory.md) — short-term (in-context) is live; long-term (retrieved) is the next add.
- [06-error-recovery.md](06-error-recovery.md) — how `tool_result is_error:true` plus 9-fault load harness produced the graceful-degradation receipt.

## The load-bearing files in this sub-section

- `lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts` — the five agents.
- `lib/agents/aptkit-adapters.ts` — the three adapters: `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`.
- `lib/agents/tool-schemas.ts` — the per-agent tool filter.
- `lib/data-source/fault-injecting.ts` — the chaos decorator that produced the graceful-degradation numbers.
- `lib/data-source/types.ts` — the DataSource port (5 uses, zero caller-surface change).
