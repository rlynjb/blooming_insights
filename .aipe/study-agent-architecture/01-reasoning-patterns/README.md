# 01 — Reasoning patterns

How one model thinks through a task. This is the substrate every topology in SECTION C sits on top of — a supervisor-worker system is supervisor and workers each running one of these patterns inside their own ReAct loop. Cover the family, name where this codebase sits, and name the escalation ladder between them.

`Anchor:` single-agent (primary) · workflow (secondary).

---

## Files in this sub-section

- **`01-chains-vs-agents.md`** — the boundary file. Who writes the steps: engineer (chain) or model (agent)? blooming insights is *both* at two layers: the route's `if`-ladder is a chain, each agent's `runAgentLoop` is an agent. Read this first.
- **`02-react.md`** — the baseline single-agent pattern. `runAgentLoop` (`lib/agents/base.ts` L48–L176) IS the ReAct loop, reused by all four agents (monitoring, diagnostic, recommendation, query) under different prompts and budgets. Defines the escalation ladder used by the rest of the section.
- **`03-plan-and-execute.md`** — escalate when the path is knowable up front and the executor can stay cheap. blooming insights does NOT use this as a runtime phase; the closest analog is the static "Suggested query plan" section in the monitoring prompt (`lib/agents/prompts/monitoring.md` L39–L47) — a plan-in-prompt, not a plan-phase.
- **`04-reflexion-self-critique.md`** — escalate when the failure is recognizable to the same model on a second pass. blooming insights does NOT use a critic loop; `synthesize()` in `DiagnosticAgent` and `RecommendationAgent` is a forced-synthesis recovery (same model, no tools, commit now) — not a judgment step. Names the shared-blind-spot limit.
- **`05-tree-of-thoughts.md`** — branch-and-score reasoning. blooming insights correctly does NOT use this — branch factor × depth × per-step cost is the wrong shape under a ~1 req/s MCP rate limit and a 300s ceiling on a smooth answer surface. Knowing *why* you didn't use it is the senior answer.
- **`06-routing.md`** — heuristic-first then LLM-second router for the free-form `?q=` path (`lib/agents/intent.ts`). The BRIDGE to multi-agent: same shape that picks a tool inside one agent picks an agent across many. Sets up SECTION C.

---

## Reading order

```
   01-chains-vs-agents      ← the boundary — start here
            │
            ▼
   02-react                  ← the baseline ReAct loop
            │
            ▼
   06-routing                ← the bridge to multi-agent
            │ (then the family of ReAct escalations)
            ▼
   03-plan-and-execute       ← escalation: the path is knowable
   04-reflexion-self-critique← escalation: the failure is recognizable
   05-tree-of-thoughts       ← escalation: branch and score (and why not here)
```

Read 01 first to name the chain/agent boundary in this codebase. Read 02 to see the one ReAct loop four agents share. Read 06 next because it bridges from single-agent (routing a tool) to multi-agent (routing an agent) — it's the conceptual hop to SECTION C. Then read 03 / 04 / 05 in any order as the family of escalations from ReAct, each one naming a different failure mode and the structural cost it pays to fix it.

---
