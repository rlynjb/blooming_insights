# 06 — Orchestration system design templates

An **orchestration system design template** is an interview reframe of the codebase as an agentic system: the verbatim whiteboard prompt ("design an agentic X"), answered first with the canonical generic topology and then mapped honestly onto what blooming insights actually does. These files use a different shape from the per-concept study files — **nine labelled bullets** (the prompt, standard architecture, data model, key components, scale concerns, eval framing, common failure modes, applies-to-this-codebase, how-to-make-it-apply) instead of the Why-care / How-it-works template. The first seven bullets are generic and reusable; only the last two are blooming-insights-specific, and they are answered against the real code.

The three templates are generic and generated for **every** agent-architecture guide regardless of shape — so the reader is fluent in all three orchestration archetypes whether the studied repo exercises them or not.

## Files

- **[01-multi-agent-research-assistant.md](01-multi-agent-research-assistant.md)** — "Design a system that answers a complex research question by gathering from multiple sources and synthesizing." Canonical supervisor-worker fan-out + synthesis. **Applies: partially.** Blooming insights is a gather-then-synthesize system (monitoring → diagnostic → recommendation), but with **one source** (Bloomreach MCP), **deterministic orchestration** (route code in `app/api/agent/route.ts:199–249`, not an LLM supervisor), and **sequential user-gated stages** (no fan-out — the ~1 req/s Bloomreach rate limit makes parallelism unprofitable here).
- **[02-agentic-support-system.md](02-agentic-support-system.md)** — "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't." Canonical intent router → ReAct → guardrails → action gate + escalation. **Applies: partially.** Blooming insights has the front half (intent router in `lib/agents/intent.ts`, single-agent ReAct in `lib/agents/query.ts`, output validators in `lib/mcp/validate.ts`, read-only tools) but intentionally lacks the back half — recommendations are *suggestions* for the human to enact in Bloomreach, not actions the agent takes; there is no action gate, no escalation, and no audit log because the agent never acts.
- **[03-agentic-coding-system.md](03-agentic-coding-system.md)** — "Design an agent that completes a coding task across a repo — read, plan, edit, verify." Canonical plan-and-execute + verifier-critic + writable-file allowlist. **Applies: no.** Blooming insights is a data analyst over Bloomreach Engagement, not a coding agent. The plan/execute/verify shape rhymes loosely with monitoring → diagnostic → recommendation, but the substrate (EQL queries vs. files and tests) has no overlap. Included for cross-pattern fluency, not as a refactor target.

## How to read these

Reading order does not matter — **each file is self-contained**. Pick the template whose prompt best matches the system you're being asked to design, or read all three for full coverage.

Read the prompt and the standard architecture as if you were at the whiteboard — they are the answer you would give in any interview, codebase or not. Then read the last two bullets as the honest follow-up an interviewer drills into: *"your repo does something like this; how does it actually compare to the canonical design, and what would it take to match it?"* The value of these files is the gap between the canonical topology and the real code — and being able to defend why blooming insights chose the **minimal multi-agent topology** (deterministic sequential pipeline, single source, no LLM supervisor, no action-taking, no coding) over the maximal versions in the templates.

## Why this shape, not the per-concept template

The per-concept template (Subtitle / Why care / How it works / In this codebase / Elaborate / Tradeoffs / Tech reference / Summary / Interview defense / Validate / See also) is the right shape for explaining a *single pattern*. These files are not explaining a pattern — they are explaining an *interview prompt*. The nine-bullet shape lets the prompt, the standard answer, and the honest codebase mapping live side by side at the same level of structure, which is what the interview conversation actually needs.

---
