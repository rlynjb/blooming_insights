# 01 — Reasoning patterns

Anchor: **single-agent** (primary) · workflow (secondary)

The substrate every worker in this repo runs on. Each agent is one reasoning pattern instantiated over MCP tools. This section covers the whole family so you can defend which one you picked and why you didn't reach for the fancier ones.

## Reading order

Files are self-contained, but the internal ladder is intentional:

1. **[01-chains-vs-agents.md](./01-chains-vs-agents.md)** — the boundary. Is there a loop at all?
2. **[02-agent-loop-skeleton.md](./02-agent-loop-skeleton.md)** — the kernel every named pattern below instantiates. Read this before ReAct.
3. **[03-react.md](./03-react.md)** — the baseline this repo actually uses. Where it sits in the family.
4. **[04-plan-and-execute.md](./04-plan-and-execute.md)** — the escalation you'd reach for on structured tasks.
5. **[05-reflexion-self-critique.md](./05-reflexion-self-critique.md)** — layer critic on top of any base pattern.
6. **[06-tree-of-thoughts.md](./06-tree-of-thoughts.md)** — the pattern you cover so you can defend NOT using it.
7. **[07-routing.md](./07-routing.md)** — pick the right handler before committing to a loop.
