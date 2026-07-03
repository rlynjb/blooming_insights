# study-ai-engineering — index

Per-codebase AI engineering study guide for `blooming_insights` — a Next.js multi-agent AI analyst that runs the diagnose → decide loop over a Bloomreach Engagement workspace, built on `@aptkit/core@0.3.0` and streamed to the UI as NDJSON.

Start with `00-overview.md`. Then walk the sub-directories in order — each has its own README with a reading order.

## Sub-directories

- `01-llm-foundations/` — the model as an IO function, tokens, sampling, structured outputs, streaming, cost, heuristic-before-LLM, provider abstraction, override locks.
- `02-context-and-prompts/` — the finite context window, lost-in-the-middle, prompt chaining (the diagnose → recommend handoff is a chain).
- `03-retrieval-and-rag/` — mostly "not exercised" for this repo. The agents query structured data, not text over vectors. Concept files present for shape completeness.
- `04-agents-and-tool-use/` — the load-bearing sub-section. Agent-vs-chain, tool calling, ReAct, tool routing, agent memory, error recovery. AptKit owns the loop; this repo owns the adapter bridge.
- `05-evals-and-observability/` — the tier-2 story. Eval sets, methods, LLM-as-judge biases, LLM observability. 10 goldens × 2 rubrics × 4 dims × 3 verdicts, per-case receipt, judge-error resilience, signal-class-aware gate.
- `06-production-serving/` — prompt caching (live), cost optimization (Haiku for intent), prompt injection surface, rate limiting + backpressure (partial — inbound to the MCP server, not to the app), retry + circuit breaker (retry present, breaker not).
- `07-system-design-templates/` — interview reframes: search-ranking (no), tech-support chatbot (partially — the ReAct loop is structurally similar).
- `08-machine-learning/` — largely "not exercised." Files present per spec for shape recognition and Case B project exercises.
- `09-ml-system-design-templates/` — interview reframes: recommender (no), anomaly detection (**partially — YES actually, the monitoring agent IS anomaly detection**), object detection (no).

## Two "features in this codebase" files at root

- `ai-features-in-this-codebase.md` — per-feature table of every AI-touching thing in the repo: which agent, which prompt, which pattern, which files.
- `ml-features-in-this-codebase.md` — the honest short list. This codebase has no trained ML.

## What's real, what's stubbed

The overview (`00-overview.md`) has the current-state snapshot. Key numbers to anchor against, from the committed baseline run (`eval/baseline.json`, runId `2026-07-03T04-08-28-644Z`):

- 10 golden cases, 4 signal classes (has-signal, partial-signal, no-signal, positive)
- Per-case cost: ~$0.09 agent-side (cached). Total 10-case run: $0.913 agent + ~$0.40 judge estimate = ~$1.30
- Per-phase p50 latency: diagnose 50s · diagnosis-judge 38s · recommend 51s · rec-judge 90s · total 225s
- Diagnosis dim pass rates: root_cause_plausibility 75% · evidence_grounding 50% · scope_coherence 75% · actionable_next_step 0%
- Recommendation dim pass rates: diagnosis_response 48% · feature_choice_fit 62% · step_actionability 100% · impact_realism 43%
- Session D pilot calibration (AI-vs-AI, 6 cases): verdict agreement 6/6 (100%) · exact-match dims 13/24 (54%) · within-1 dims 24/24 (100%)
