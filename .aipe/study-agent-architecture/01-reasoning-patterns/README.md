# 01 · Reasoning patterns

How one model thinks through a task. The substrate every multi-agent topology sits on top of.

## Files

1. [`01-chains-vs-agents.md`](./01-chains-vs-agents.md) — the boundary that splits "engineer wrote the steps" from "model picks the steps"
2. [`02-agent-loop-skeleton.md`](./02-agent-loop-skeleton.md) — the load-bearing kernel every loop in this repo instantiates (READ THIS — it's the kernel)
3. [`03-react.md`](./03-react.md) — the default single-agent pattern; what all four loop-shaped agents in this repo are
4. [`04-plan-and-execute.md`](./04-plan-and-execute.md) — separate planning from doing (not in this repo; placement only)
5. [`05-reflexion-self-critique.md`](./05-reflexion-self-critique.md) — agent grades its own output and retries (not in this repo)
6. [`06-tree-of-thoughts.md`](./06-tree-of-thoughts.md) — branch + score + pick (not in this repo; rarely worth it)
7. [`07-routing.md`](./07-routing.md) — heuristic-first then LLM router; this repo uses it for intent classification

## How this maps to the codebase

| File | In this codebase? |
|---|---|
| chains-vs-agents | **Both** — `app/api/agent/route.ts` is the chain; the four AptKit-backed agents are the agents inside it. |
| agent-loop-skeleton | **Yes** — every loop is `runAgentLoop()` in `@aptkit/core@0.3.0`. The most load-bearing file in this guide. |
| ReAct | **Yes** — monitoring, diagnostic, recommendation, query are all ReAct. |
| plan-and-execute | **No** — not implemented. Diagnostic comes closest (hypothesize then test) but the model still re-plans every turn. |
| reflexion | **No** — diagnosis is final; no critic agent re-grades it. |
| tree-of-thoughts | **No** — never worth it for this product. |
| routing | **Yes** — intent classifier is the LLM-router; the URL `?step=` is the heuristic-router. |
