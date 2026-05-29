# 04 — Agents and tool use

This is the codebase's strongest sub-section. The four specialist agents (monitoring, diagnostic, recommendation, query) all share one loop — `runAgentLoop` in `lib/agents/base.ts` — and every concept in this directory is a different lens on that single ~130-line function and the route that orchestrates it. The route now runs the investigation as two `?step`-gated calls (`step=diagnose` then `step=recommend`, with the diagnosis handed between them), and the trace consumer lives in `lib/hooks/useInvestigation.ts`. If you understand `base.ts` L48–L176, `lib/mcp/tools.ts`, and `app/api/agent/route.ts`, you understand the heart of blooming insights.

## Files

- **[01-agents-vs-chains.md](01-agents-vs-chains.md)** — The defining architecture: a deterministic CHAIN of agents at the top (`route.ts` runs diagnostic→recommendation as two `?step`-gated calls with a diagnosis handoff), a bounded AGENT loop at each node (`base.ts` — model owns control flow), and a 2-step micro-chain inside an agent (`runAgentLoop` then `synthesize`). Both shapes coexist by design.
- **[02-tool-calling.md](02-tool-calling.md)** — The brain/hands split: the model emits `tool_use`, your loop runs it and feeds back `tool_result` (`base.ts` L129–L171). `filterToolSchemas` maps MCP defs → Anthropic `Tool[]`; the model never runs the tool, the loop does.
- **[03-react-pattern.md](03-react-pattern.md)** — Thought→Action→Observation made literal and STREAMED: `onText` → reasoning_step, `tool_call_start`, `tool_call_end` + result-as-next-user-turn. The trace is a live product surface (`events.ts`, NDJSON over `fetch`), consumed by the StrictMode-safe `useInvestigation` hook.
- **[04-tool-routing.md](04-tool-routing.md)** — Two routings: per-agent tool SUBSETS (routing by construction — the wrong tool is never offered, `tools.ts`) and heuristic-first / LLM-second intent routing for `?q=` (`parseIntent` then `classifyIntent`, `intent.ts`).
- **[05-agent-memory.md](05-agent-memory.md)** — Short-term = the per-run `messages` array (`base.ts`); long-term = exact-keyed snapshot replay (`state/investigations.ts`), now `step`-filtered on replay and saved only on the combined capture run. No semantic/vector recall — that is the RAG-inside-an-agent pattern, deliberately deferred (cross-link `../03-retrieval-and-rag/`).
- **[06-error-recovery.md](06-error-recovery.md)** — Every failure has a coded recovery: forced-final tool-less turn caps the loop, `synthesize()` rescues unparseable output, `FALLBACK`/`[]` are the safe defaults, exponential-backoff rate-limit retry + no-cache-on-error, the route's pre-stream setup `try/catch`, and a one-time client auto-reconnect on a revoked alpha token. The budget IS the loop protection.

## Reading order

Read in order: **02 (the round-trip) → 03 (streamed as ReAct) → 04 (which tools, which agent) → 01 (how the agents compose) → 05 (what they remember) → 06 (how each fails safely).**

This guide is the AI-engineering lens on the same loop the system-design guide covers in `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` — read that file for the orchestration/streaming systems view; read this directory for the agent-design view. They are consistent, not duplicative.

---
Updated: 2026-05-28 — Refreshed the run-flow one-liners for the two-step `?step=diagnose`/`?step=recommend` split, the `useInvestigation` trace consumer, exponential-backoff retry, and the new route/client recovery guards.
