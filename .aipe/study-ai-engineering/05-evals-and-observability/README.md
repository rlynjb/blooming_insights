# 05 — Evals and observability

This sub-section is two halves of one question — *how do you know your LLM feature is any good, and how do you see what it did?* — and blooming insights now sits on **opposite sides of each half**.

**Observability is a product strength (Case A).** Every investigation already emits a typed trace: `reasoning_step` / `tool_call_start` / `tool_call_end{durationMs}` events (`lib/mcp/events.ts`), streamed live to the UI as the agent's visible work — a sticky `StatusLog` sidebar on both investigate steps, an inline panel on the feed, each line timestamped and the reasoning pretty-printed by `TraceContent`, all fed by the StrictMode-safe `useInvestigation` hook — narrated per call by `describeToolCall` (`app/api/briefing/route.ts`), and replayed event-for-event from the investigation cache (`lib/state/investigations.ts`). The trace is not a backend log — it *is* the product surface.

**Evals are Case B again.** The Phase-3 `eval/` directory (the 4-pillar harness — detection / diagnosis / recommendation / regression — with LLM-as-judge prompts under `eval/judges/`, fixtures under `eval/fixtures/`, and dated paper trails under `eval/results/`) was removed in **PR #8 (commit 62c24d7)** along with the Olist MCP server it ran against. There are no live-agent quality numbers in the repo right now. The 221 Vitest tests still inject fakes and assert plumbing — they did not go away — but the parallel "real-money quality measurement" layer is gone. The concept files in this sub-section walk the patterns as study material, and `05-regression-evals.md` is preserved with a RETIRED banner because the subject is no longer in the repo.

## Files

- **[01-eval-set-types.md](01-eval-set-types.md)** — *Case B.* The three eval set shapes (golden, adversarial, regression) and why a 221-test Vitest suite that mocks the model can't tell you whether the model's answers are *good*. The repo has no golden / adversarial / regression sets right now; the exercises in the file build them.
- **[02-eval-methods.md](02-eval-methods.md)** — *Case B.* The scoring ladder (exact-match → fuzzy/F1 → rubric → LLM-judge → pairwise → human) with the right rung for each agent surface. No scorer is wired in-repo today; the exercises build a runner that selects the right rung per surface.
- **[03-llm-as-judge-bias.md](03-llm-as-judge-bias.md)** — *Case B (theoretical).* The three judge biases (position, verbosity, self-preference) and their mechanical fixes. The codebase no longer ships any LLM-judge surfaces, so the self-preference trap that was once live is dormant — re-reads as study material describing the bias a future judge harness would have to control.
- **[04-llm-observability.md](04-llm-observability.md)** — *Case A, RICH.* The NDJSON event stream IS a live trace. `tool_call_start`/`tool_call_end{durationMs}` (`events.ts`) is a span; `durationMs` captured at the single `mcp.callTool` choke-point times every span by construction; one captured `AgentEvent[]` serves the live UI (`useInvestigation` → `StatusLog`/`ReasoningTrace`/`TraceContent`, timestamped), the briefing's per-call `describeToolCall` status line, and event-for-event replay. Honest gaps: no Langfuse, no span aggregation, no queryable store, replay is verbatim-only.
- **[05-regression-evals.md](05-regression-evals.md)** — *RETIRED.* The regression-eval pattern (capture-then-score with structural-diff + similarity-judge two-mode scoring) was wired against `eval/scripts/run-regression.ts` + `eval/judges/similarity-judge.md`, both gone in PR #8. The file is preserved with a banner; the pattern itself is real and worth reading, but the repo no longer exercises it.

## Reading order

Read in order: **04 (what observability the codebase HAS — the trace, the strength) → 01 (the eval set types as study material) → 02 (the scoring methods as study material) → 03 (the judge biases as background) → 05 (RETIRED — read only as a historical pattern walkthrough).**

Start with 04 because it is the original anchored half — the live trace grounds the spans/durations/replay abstraction in real files. Then 01–03 walk the eval half as study material; the exercises name what would have to be built to reach for them in this codebase again. 05 closes as a RETIRED-banner record of what was studied while the eval suite existed.

This guide is the AI-engineering lens; the observability mechanics overlap the streaming/orchestration systems view in `../../study-system-design/05-streaming-ndjson.md` and `../../study-system-design/06-multi-agent-orchestration.md`. Read those for the systems view; read this directory for the evals-and-observability view.

---
