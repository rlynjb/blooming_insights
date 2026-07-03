# 06 — Orchestration system design templates

Anchor: codebases reframed as interview templates

Three interview-shaped system-design templates. Same codebase, interview framing. Each template has the same nine bullets: prompt, standard architecture, data model, key components, scale concerns, eval framing, common failure modes, "Applies to this codebase" (honest yes/partially/no), and "How to make it apply" (concrete refactor).

## Reading order

1. **[01-multi-agent-research-assistant.md](./01-multi-agent-research-assistant.md)** — the fan-out + synthesis template.
2. **[02-agentic-support-system.md](./02-agentic-support-system.md)** — the intent-routed single-agent-with-guardrails template.
3. **[03-agentic-coding-system.md](./03-agentic-coding-system.md)** — the plan-and-execute + verifier template.

Each template is generated for every guide regardless of shape — the "Applies to this codebase" bullet gives an honest assessment of match, and "How to make it apply" names the specific refactor.
