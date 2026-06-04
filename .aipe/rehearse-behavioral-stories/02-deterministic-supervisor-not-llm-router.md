# Story: chose a 6-line `if`-ladder over an LLM supervisor — and defended it

**Competency:** technical-judgment
**Also probes:** prioritization-and-saying-no (declined the default framework path)
**Lands at:** Anthropic | Meta | Google | all
**Project / context:** blooming insights (Loomi Connect AI Hackathon, 2026-05-27 → 2026-06-02)
**Cross-link:** [`.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md`](../rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md) · [`.aipe/rehearse-interview-defense/03-the-choices.md`](../rehearse-interview-defense/03-the-choices.md)

---

## Situation

Day 1 of the 7-day Loomi Connect window. The sponsor track was "AI agent over Bloomreach MCP" — a brand-new MCP server no one had built against — and the demo-worthy goal was a multi-stage diagnostic that produces an enriched insight, runs a tool-using investigation, then proposes typed actions. The default 2026 instinct for that shape is **multi-agent with an LLM supervisor**: LangGraph, CrewAI, Autogen, or a custom orchestrator-agent reasoning about which worker to invoke next. That's the path of least typing in a hackathon and the path the demo audience would expect to see.

## Task

I owned the architecture call. Specifically: **who decides which agent runs next** — code, or an LLM. This is the decision that splits the codebase into "multi-agent with adaptive routing" vs "multi-agent with deterministic pipeline." It looks like a small decision and it isn't — it sets the cost ledger, the debuggability story, the test surface, and the answer to "why didn't you use LangGraph?" for the rest of the project.

## Action

I held the line against the LLM-supervisor instinct. The reasoning that made the call: **the decision the supervisor would make is already known at code-write time.** The order is `monitoring → diagnostic → recommendation`. There is no run where a supervisor could plausibly choose differently with the information it has. Paying an LLM call per inter-stage decision to re-derive a fact that's in source code is the textbook 2-5x coordination tax for zero benefit.

I considered four alternatives and rejected all four:

1. **LLM supervisor (the LangGraph / CrewAI shape).** Rejected — adaptive routing earns its keep when the next stage *depends* on what the previous stage discovered. Mine doesn't. If diagnosis comes back inconclusive, I don't auto-route to a different specialist — I move to recommendation and let the user decide.

2. **Single mega-agent with all tools.** Rejected — this was the original shape and it failed structurally: tool-budget contention (12 tools, 6-call budget → starved sub-jobs), prompt-length blowup (one prompt covering "monitor → diagnose → recommend" lost task structure), schema mixing (no clean output type). Decomposition was forced by these failures, not by routing complexity.

3. **LangGraph (or equivalent framework).** Rejected — pulls in a dependency the size of the rest of the agent code combined, for an `if`-ladder of 3 cases. The framework's primitives scale with graph complexity; mine is a line. Vendor lock on orchestration shape.

4. **Swarm / handoff (peer agents transferring control).** Rejected — no peer specialists, no triage shape, no runtime data driving the next-agent choice. Doesn't match the workload.

I built it as: **per-agent definitions own their own prompt, tool subset, budget, and output schema** (`lib/agents/monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`); **a shared ReAct loop** (`lib/agents/base.ts:48-176`) owns the model-side control flow within each agent (`thought → tool_use → tool_result → repeat`, with a `maxToolCalls` budget and a forced-final synthesis turn); and **a 6-line `if`-ladder in `app/api/agent/route.ts:196-254`** owns the code-side control flow between agents. The supervisor is six lines. It says: "the order is monitoring → diagnostic → recommendation."

The classifier intent agent uses Claude Haiku 4.5 instead of Sonnet 4.6 — same "pay only for what the job needs" instinct, applied at the per-call level. Classification doesn't need Sonnet-grade reasoning.

Then I wrote RFC-003 (`.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md`) to defend the choice in writing — the rejected alternatives matrix, the cost ledger ($0 routing cost vs $0.05-0.20/run for an LLM supervisor), the seven tradeoffs accepted, the named risks with mitigations, the open questions, and the framing for the obvious reviewer pushback ("why didn't you use LangGraph?"). The RFC is the artifact that makes the choice defensible under interview probing.

## Result

The repo shipped on deadline at ~3,400 LOC across 58 source files with 169 vitest tests, none of which require an Anthropic API key thanks to the provider abstraction RFC pair (RFC-001 + RFC-003). The orchestration is debuggable by reading code — a failed investigation in production says "ran diagnostic, then recommendation," not "the supervisor chose X because of [opaque reasoning]." Adding a stage is a code change to one file with a code review; removing a stage is the same.

The cost-ledger result that survives interview pushback: **~$0.10 per investigation** (4 worker LLM calls + 1 classifier Haiku call), vs the estimated **~$0.20-$0.50** for an LLM-supervisor variant. The 2-5x coordination tax I avoided is the real number the RFC defends.

The 2026-06-02 recon audit named this as the **strongest competency in the repo** — agents + tool-use + MCP orchestration at L2, "the depth here is unusual for a solo-built portfolio project." RFC-003 is one of the 3 RFCs the audit credits with passing all four "warrants a doc" tests, and the cited reason is exactly that the rejected alternatives are named with the load-bearing facts behind each rejection.

## What I'd do differently / what I learned

I'd write the RFC at decision time, not after. RFC-003 is a *post-hoc* artifact — I wrote it during the rehearse-design-doc generator pass, several days after the architecture was settled. The honest version: the decision was real at the time but the documentation was retrospective. If I were doing it again, the RFC would land in the same PR as the route-handler `if`-ladder, so the artifact is co-located with the code change that implements it. The current state is "decision was right; documentation followed later" — the senior move is "decision and documentation co-land."

---

## Defense — likely follow-ups

- **Q: Why didn't you use LangGraph / CrewAI / [framework]?**
  A: The framework's primitives solve coordination problems I don't have. Three stages in a known order is an `if`-ladder, not a graph. Adopting the framework would cost a dependency and a learning curve for capability I don't use. The day I have a graph (or 12 agents, or adaptive routing), the trade flips. RFC-003 names this explicitly: "There is a real version of this story where a team with 8 engineers and 12 agents adopts LangGraph and benefits. That is not us."

- **Q: Isn't this just a workflow? Why call it multi-agent?**
  A: The cross-stage control is workflow-shaped (code-owned, fixed order). The within-stage control is agent-shaped (model-owned, variable — the ReAct loop decides which tools to call, how many turns to use, when to stop). Both are true. The boundary between them is the load-bearing detail: work-inside-stage is non-deterministic enough that you need an agent loop; order-between-stages is deterministic enough that you don't.

- **Q: What's the trigger for replacing the `if`-ladder with an LLM supervisor?**
  A: The day a stage's *output* needs to change which stage runs next — meaning the next-agent identity depends on runtime data the code can't predict at write time. Today my diagnosis going "inconclusive" still routes to recommendation (the user decides what to do); if I had multiple diagnostic specialists with overlapping competence and "inconclusive" needed to escalate to a deeper one, the supervisor earns its overhead. Until then, it doesn't. RFC-003 names this trigger explicitly so the next decision-point is falsifiable.

- **Q: You're hand-rolling orchestration. That doesn't scale.**
  A: It scales to ~3 stages and ~1 engineer. It would not scale to 20 stages and a team — but that's not the workload. The deterministic shape is the right point on the cost ledger for *this specific problem*. The framework shape is the right point for a *different* problem. I picked the point that matches the workload.

- **Q: The `if`-ladder is fragile. One typo and the wrong agent runs.**
  A: The test suite covers it — 169 tests, including the orchestration tests, none of which require an Anthropic API key thanks to the provider abstraction (RFC-001's encrypted-cookie OAuth pair). The supervisor's choices are deterministic, so testing them is testing `if` branches, not "what did the LLM decide this time." A typo in an `if`-ladder is caught by a unit test; an LLM-supervisor's "wrong choice" requires re-running the supervisor's prompt against logged context to even understand.

- **Q: How do you know this was the right call vs the LangGraph version you didn't build?**
  A: Honest answer: I don't have an A/B against the LangGraph version. What I have is a defensible *negative result* — the LLM-supervisor pattern earns adaptive routing as its primary value, and my workload doesn't need adaptive routing. That's the falsifiable claim. If you handed me a workload where the next-stage decision depended on what the previous stage discovered (a triage system with 20 sub-specialists, for example), I'd reach for the LLM supervisor pattern there. Different workload, different shape.
