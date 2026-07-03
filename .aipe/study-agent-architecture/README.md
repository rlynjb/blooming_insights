# Agent architecture — blooming insights

The shape of the whole guide, and the order to read it.

## What this repo is (one paragraph)

A Next.js multi-agent AI analyst over a Bloomreach Engagement workspace. Four specialist agents (monitoring, diagnostic, recommendation, query) sit behind a **deterministic supervisor** — the route handler routes by code, not by an LLM. The supervisor picks the agent, hands it the shared `WorkspaceSchema` + tool list, streams every reasoning step and tool call to the UI, and enforces a per-investigation budget. The connective tissue is the MCP protocol (Bloomreach loomi connect as the default preset), swappable via an auth-provider abstraction (OAuth-Bloomreach / bearer / anonymous) and a UI-level config override header. The agents themselves are `@aptkit/core` reusable classes bridged into the repo through a 3-class adapter set (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`).

The shape is **multi-agent, code-routed** — a supervisor-worker topology whose supervisor is a route handler, not another LLM. Every worker is one ReAct loop with tools.

## Reading order

```
  orient → single agent  → many agents → what wraps them → templates
  ┌────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌─────────┐
  │ 00 │ → │  01, 02  │ → │    03    │ → │   04, 05   │ → │   06    │
  └────┘   └──────────┘   └──────────┘   └────────────┘   └─────────┘
   over-      reasoning +   multi-agent    infra +          system-design
   view       retrieval     orchestration  production       templates
```

Cross-section, `A → B → C → D → E → F`. Within a sub-section, files are self-contained; each sub-section README notes local reading order.

## Sub-sections

- **[00-overview.md](./00-overview.md)** — the whole system in one diagram, plus the three-shapes framing (this repo is multi-agent, code-routed).
- **[01-reasoning-patterns/](./01-reasoning-patterns/README.md)** — how one agent thinks: chains vs agents, the loop skeleton, ReAct, plan-and-execute, reflexion, tree of thoughts, routing.
- **[02-agentic-retrieval/](./02-agentic-retrieval/README.md)** — retrieval as a control loop: agentic RAG, self-corrective RAG, retrieval routing. Cross-refs `study-ai-engineering` for mechanics.
- **[03-multi-agent-orchestration/](./03-multi-agent-orchestration/README.md)** — nine files. Everything above one agent: when NOT to, supervisor-worker, pipeline, fan-out, debate, swarm, graph, shared state, coordination failures.
- **[04-agent-infrastructure/](./04-agent-infrastructure/README.md)** — context engineering, memory tiers, tool calling + MCP, agent evaluation, guardrails.
- **[05-production-serving/](./05-production-serving/README.md)** — cross-turn caching, fan-out backpressure, per-tool circuit breaking. The three serving concerns that only show up once the unit is a loop.
- **[06-orchestration-system-design-templates/](./06-orchestration-system-design-templates/README.md)** — three interview-shaped system-design templates (research assistant, agentic support, agentic coding), each reframed against this repo.
- **[agent-patterns-in-this-codebase.md](./agent-patterns-in-this-codebase.md)** — the patterns table, walkthrough of what's actually shipped.

## Cross-references

Where a concept already lives in `study-ai-engineering.md`, this guide links out rather than re-teaching. The seam:

```
  study-ai-engineering.md          this guide
  ───────────────────────          ────────────────────────────
  one model / one agent            what happens ABOVE one agent
  retrieval mechanics              retrieval as a control loop
  agents-vs-chains mechanics       reasoning patterns family
  tool-calling mechanics           tool calling as substrate
  LLM eval mechanics               trajectory + tool-call eval
  single-call serving              cross-turn / topology serving
```
