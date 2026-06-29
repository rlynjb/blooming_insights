# 06 — Orchestration system design templates

Anchor: codebases reframed as interview templates

Three generic system-design templates that mirror the same template-shape used in `study-ai-engineering`'s system-design sub-section. Each follows a fixed nine-bullet structure (prompt / standard architecture / data model / key components / scale concerns / eval framing / common failure modes / applies to this codebase / how to make it apply). The first seven bullets are generic to the template; the last two are answered against this repo.

The point: same code, interview framing. The exercise of asking "could I describe this codebase as the canonical answer to template X?" surfaces what's there, what's partially there, and what the refactor would look like.

## The three templates and how they fit

1. **`01-multi-agent-research-assistant.md`** — partial fit. The investigation pipeline does decompose-query → retrieve-evidence, but the synthesis is missing (no LLM merger; each agent's output is the final word for its stage).

2. **`02-agentic-support-system.md`** — partial fit. The QueryBox path is the closest match; the diagnostic agent + recommendation pipeline is a different shape. The "takes real actions" piece doesn't apply (recommendations are proposals, not auto-executed actions).

3. **`03-agentic-coding-system.md`** — no fit. The repo isn't a coding agent. Included for completeness because the spec ships all three regardless of shape.
