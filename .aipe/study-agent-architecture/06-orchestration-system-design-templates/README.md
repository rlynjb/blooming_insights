# 06 · Orchestration system design templates

Three generic interview-style design prompts, each reframed against the codebase. Same nine-bullet template per prompt: the prompt, standard architecture, data model, key components, scale concerns, eval framing, common failure modes, applies to this codebase, how to make it apply.

## Files

1. [`01-multi-agent-research-assistant.md`](./01-multi-agent-research-assistant.md) — "answer a research question by gathering from multiple sources and synthesizing"
2. [`02-agentic-support-system.md`](./02-agentic-support-system.md) — "resolve user requests by taking real actions across tools, escalating when it can't" — **closest match to this repo**
3. [`03-agentic-coding-system.md`](./03-agentic-coding-system.md) — "complete a coding task across a repo — read, plan, edit, verify"

## How to read

Each template is generic — the "standard architecture" and "scale concerns" bullets describe the canonical shape independent of any codebase. The last two bullets — **Applies to this codebase** and **How to make it apply** — are answered specifically about *this* repo.

The point: in an interview where the prompt is "design an agentic X system," you walk the standard architecture; in defense, you anchor to your repo. The applies/how-to bullets are the bridge.
