# Agent architecture — `blooming_insights`

A per-codebase study guide for the agent-architecture topic, applied to this repo.

## Reading order

Start with `00-overview.md`. Then walk the sub-sections in order:

1. **`01-reasoning-patterns/`** — how one agent thinks. The substrate every loop sits on.
2. **`02-agentic-retrieval/`** — placement of this repo's retrieval (live MCP data, not vector RAG).
3. **`03-multi-agent-orchestration/`** — what's *above* one agent. The deliberate non-escalation lives here.
4. **`04-agent-infrastructure/`** — context, memory, tools, evaluation, guardrails. Cross-cutting.
5. **`05-production-serving/`** — what changes when the unit is a loop, not a single call.
6. **`06-orchestration-system-design-templates/`** — interview-shaped reframings.

At the root:

- `00-overview.md` — the shape, the three-shapes call, the settled vocabulary.
- `agent-patterns-in-this-codebase.md` — the actual patterns this repo runs, named.
- `audit.md` — checklist against every pattern in the spec, honest verdicts.

## What this repo *is*, in one line

A sequential pipeline of three single-agent ReAct loops (`MonitoringAgent` → `DiagnosticAgent` → `RecommendationAgent`) plus a fourth `QueryAgent` on a separate ingress, dispatched by deterministic TypeScript in two Next.js route handlers (`app/api/briefing/route.ts`, `app/api/agent/route.ts`). The agent loop itself comes from `@aptkit/core@0.3.0`; this repo's `lib/agents/*.ts` files are thin adapters (40–120 LOC each) over four AptKit agent classes.

## Three-shapes weighting

```
  workflow outside   ◄── this repo
  single-agent inside ◄── this repo
  multi-agent         ◄── not yet (deliberately)
```

So: A and D are deep; C is mostly "deliberately not." Section C still has full breadth, because the value is teaching the topology family and naming the deliberate non-escalation — not pretending the repo runs a debate loop.

## The cross-references

This guide cites two sibling guides that aren't in this repo yet but would live alongside it:

- `study-ai-engineering` — for ReAct mechanics, tool-calling mechanics, RAG mechanics, single-call caching / cost / rate-limit / circuit-breaker mechanics, LLM-as-judge bias, prompt-injection defenses.
- `study-system-design` — for the request flow, the OAuth boundary, the streaming NDJSON pattern, the provider abstraction (the same `DataSource` seam this guide leans on).

This file (and every file under it) covers what's *only* agent-architecture.
