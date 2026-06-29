# 05 — Evals and observability

The eval side of this codebase has a history: a **Phase 3 4-pillar eval suite was built on the Olist data substrate and retired in PR #8 (2026-06-18)**. The framing throughout this sub-section is "what was learned then" + "what's there now" + "what's next." Honest retired-historical treatment — never as if the eval suite were still live.

The observability side is shipped today: per-call `response.usage` logged from the adapter, per-phase wall-clock timings logged from the route, NDJSON trace events streamed live to the UI.

## Reading order

1. `01-eval-set-types.md` — golden / adversarial / regression sets (the framework; the retired Phase 3 suite used variants)
2. `02-eval-methods.md` — exact match, fuzzy, rubric, LLM-as-judge, pairwise, human (what Phase 3 used and why)
3. `03-llm-as-judge-bias.md` — position / verbosity / self-preference (and the specific calibration Phase 3 used: 8/8 + 3/3 manual spot-check)
4. `04-llm-observability.md` — traces / spans / replay (what's shipped: per-call usage logs, per-phase timings, NDJSON event traces)

The retired Phase 3 suite surfaced three real bugs — BRL cents-vs-Reais, binary calibration (29/30), conclusion instability (30%) — which appear as anchored examples throughout these files. The next eval iteration targets `SyntheticDataSource`, not Olist.
