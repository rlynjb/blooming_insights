# Section F — Orchestration system design templates

**Anchor:** codebases reframed as interview templates. Same code, interview framing.

These reframe the studied codebase (blooming_insights) as the answer to "design an agentic X system." Every template uses the fixed nine-bullet shape from `study-ai-engineering.md`. All three appear regardless of current applicability — the `Applies to this codebase` bullet is honest, and `How to make it apply` names the concrete refactor.

## Files

1. **`01-workflow-outside-agent-inside.md`** — blooming's actual shape: deterministic supervisor + ReAct workers. The interview answer when someone asks "how would you build this?"
2. **`02-agentic-support-system.md`** — the contrast case. Where blooming DOESN'T look like a support agent — no autonomous actions, no escalation queue — and what would need to change.
3. **`03-multi-agent-research-assistant.md`** — the LLM-supervisor shape. The template blooming rejected (deterministic beats it for known-flow work). Kept as reference for when it WOULD earn its keep.

## Reading order

01 (blooming's shape) → 02 (the contrast) → 03 (the rejected alternative).
