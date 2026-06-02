# 05 — Evals and observability

This sub-section is two halves of one question — *how do you know your LLM feature is any good, and how do you see what it did?* — and blooming insights sits on opposite sides of that question for each.

**Observability is a product strength (Case A).** Every investigation already emits a typed trace: `reasoning_step` / `tool_call_start` / `tool_call_end{durationMs}` events (`lib/mcp/events.ts`), streamed live to the UI as the agent's visible work — a sticky `StatusLog` sidebar on both investigate steps, an inline panel on the feed, each line timestamped and the reasoning pretty-printed by `TraceContent`, all fed by the StrictMode-safe `useInvestigation` hook — narrated per call by `describeToolCall` (`app/api/briefing/route.ts`), and replayed event-for-event from the investigation cache (`lib/state/investigations.ts`). The trace is not a backend log — it *is* the product surface. blooming insights built the trace abstraction (spans, durations, replay) by hand.

**Evals are the Case-B gap.** There is no eval set, no eval harness, and no LLM-as-judge. The 157 Vitest tests are real and valuable, but they inject fakes and assert *plumbing* — control flow and output shape — not answer quality; `isDiagnosis` (`lib/mcp/validate.ts`) checks that a conclusion is a string, not that it is true. Every prompt edit and model swap currently ships with zero quality measurement. The three eval files below are the primary buildable target.

## Files

- **[01-eval-set-types.md](01-eval-set-types.md)** — *Case B.* The honest distinction: 157 Vitest tests are unit tests with injected fakes (no real model, no answer scoring), not evals. Golden (quality baseline), adversarial (robustness — especially apt for the unsanitized `?q=` path, `app/api/agent/route.ts` L115), and regression (every past failure frozen) sets defined as the buildable target in a new `evals/` directory. Cross-links the prompt-injection defence in `../06-production-serving/03-prompt-injection.md`.
- **[02-eval-methods.md](02-eval-methods.md)** — *Case B.* The scoring ladder: exact-match → fuzzy/F1 → rubric → LLM-as-judge → pairwise → human. Which rung fits each surface — `classifyIntent`/severity → exact-match, `MonitoringAgent.scan`'s array → F1, diagnosis/recommendation prose → rubric/judge. Climb only as high as output variability forces. Exercise: an `evals/runner.ts` pointable at the live agents.
- **[03-llm-as-judge-bias.md](03-llm-as-judge-bias.md)** — *Case B.* The judge is a biased instrument: position (favors order), verbosity (favors length), self-preference (favors its own family) — and judging `claude-sonnet-4-6` output (`lib/agents/base.ts` L9) with a sonnet judge is self-preference by construction. Fixes: randomize/average order, cap/rubric length, cross-family judge, then calibrate against humans. Exercise: a debiased judge for diagnosis quality.
- **[04-llm-observability.md](04-llm-observability.md)** — *Case A, RICH.* The NDJSON event stream IS a live trace. `tool_call_start`/`tool_call_end{durationMs}` (`events.ts`) is a span; `durationMs` captured at the single `mcp.callTool` choke-point (`base.ts` L144–L149) times every span by construction; one captured `AgentEvent[]` serves the live UI (`useInvestigation` → `StatusLog`/`ReasoningTrace`/`TraceContent`, timestamped), the briefing's per-call `describeToolCall` status line, and event-for-event replay. Honest gaps: no Langfuse, no span aggregation, no queryable store, replay is verbatim-only. Exercise: persist an `ai_trace` table.

## Reading order

Read in order: **04 (what observability the codebase HAS — the trace, the strength) → 01 (what evals it LACKS — the gap, the set types) → 02 (how you'd score them) → 03 (how the judge lies and how to debias it).**

Start with 04 because it is the implemented, anchored half — the live trace is the codebase's observability win and grounds the abstraction (spans, durations, replay) in real files. Then 01–03 build the missing eval half on top of that, and the two halves join at counterfactual replay: the observability trace, re-run with a changed prompt, is exactly what the eval harness in 02 needs.

This guide is the AI-engineering lens; the observability mechanics overlap the streaming/orchestration systems view in `../../study-system-design/05-streaming-ndjson.md` and `../../study-system-design/06-multi-agent-orchestration.md`. Read those for the systems view; read this directory for the evals-and-observability view.

---
Updated: 2026-05-28 — Test count 125→157; replaced the dead `summarizeTrace` mention with the real briefing narration (`describeToolCall`) and the grown UI surface (`StatusLog`/`TraceContent`/`useInvestigation`, timestamped); `?q=` ref L54→L115. Evals remain Case B.
