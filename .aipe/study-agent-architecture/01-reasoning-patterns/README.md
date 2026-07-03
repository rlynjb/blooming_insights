# Section A — Reasoning patterns

**Anchor:** single-agent (primary) · workflow (secondary).

How one model thinks through a task. This is the substrate every worker in `03-multi-agent-orchestration/` sits on top of.

## Files

1. **`01-chains-vs-agents.md`** — the boundary. Where "written control flow" ends and "autonomous loop" begins. This repo has both — the outer supervisor is a chain, the workers are agents.
2. **`02-agent-loop-skeleton.md`** — the kernel every ReAct/plan-execute/reflexion pattern instantiates. Named parts, budget exit, hardening seam. Anchors to AptKit's `runAgentLoop`.
3. **`03-react.md`** — placement in the pattern family. Mechanics cross-ref to `study-ai-engineering`. This repo runs ReAct in every worker — the strong prior is to start here.
4. **`04-plan-and-execute.md`** — not used in this repo. Where it would earn its keep (structured multi-file edits) and why diagnose→recommend is a chain instead.
5. **`05-reflexion-self-critique.md`** — not used. What the recovery prompt in AptKit is doing instead (structured-output rescue, not self-critique).
6. **`06-tree-of-thoughts.md`** — not used. Why single-branch reasoning wins for this kind of workspace-analysis loop.
7. **`07-routing.md`** — `classifyIntent` (Haiku router) is a real routing hop. This is also the bridge to Section C's supervisor.

## Reading order

01 → 02 → 03 first (the boundary, the kernel, the default). 07 next (routing is the bridge to Section C). 04, 05, 06 can be read as reference — they're covered so you can name why this repo *didn't* reach for them.
