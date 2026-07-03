# AI engineering — 00 · overview

## The shape of AI work in this codebase

blooming_insights is an **LLM application engineering** codebase — the loopd shape, not the contrl-mo shape. There is no trained model, no feature engineering, no training data. What there is: five agent classes, one tool-registry seam, one MCP protocol adapter with three swappable auth strategies, a 10-case eval suite with LLM-as-judge rubrics, a live prompt-caching win, and a regression gate wired into CI.

```
  Where AI lives in the system — one picture

  ┌─ UI (Next.js app router) ─────────────────────────────────┐
  │  app/page.tsx  ·  app/investigate/[id]/*  ·  StatusLog     │
  └───────────────────────────┬────────────────────────────────┘
                              │  NDJSON stream (AgentEvent)
  ┌─ Route handlers ─────────▼──────────────────────────────────┐
  │  app/api/briefing/route.ts   → MonitoringAgent               │
  │  app/api/agent/route.ts      → Diagnostic / Recommendation / │
  │                                Query / Intent classifier      │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Agent layer (thin wrappers over @aptkit/core) ────────────┐
  │  lib/agents/{monitoring,diagnostic,recommendation,query,    │
  │              intent}.ts — 5 agents, ~350 LOC total          │
  │  lib/agents/aptkit-adapters.ts — 260 LOC bridge:            │
  │    · AnthropicModelProviderAdapter  (ModelProvider port)    │
  │    · BloomingToolRegistryAdapter    (ToolRegistry port)     │
  │    · BloomingTraceSinkAdapter       (CapabilityTraceSink)   │
  │  lib/agents/{budget,pricing}.ts — cost controls             │
  └───────────────────────────┬────────────────────────────────┘
                              │  DataSource port
  ┌─ Data source seam ──────▼──────────────────────────────────┐
  │  lib/data-source/types.ts          — the port               │
  │  lib/data-source/mcp-data-source.ts — MCP adapter           │
  │  lib/data-source/synthetic-*       — deterministic fake     │
  │  lib/data-source/fault-injecting   — chaos decorator        │
  └───────────────────────────┬────────────────────────────────┘
                              │  MCP protocol (Bloomreach default)
  ┌─ Provider ─────────────▼──────────────────────────────────┐
  │  loomi connect MCP server (or any MCP server)              │
  └────────────────────────────────────────────────────────────┘

  Off to the side, feeding all of this:
  eval/ — 10 goldens, 2 rubrics, judge, receipts, baseline, gate
```

This overview names the seven sub-sections you'll walk. Each sub-section has a README that lists its concept files and reading order.

## The seven sub-sections

- **01-llm-foundations** — what an LLM is at the interface level, tokens, sampling, structured outputs, streaming, token economics, the heuristic-before-LLM router (intent classifier), provider abstraction (the `AnthropicModelProviderAdapter`), and user-override discipline.
- **02-context-and-prompts** — the context window as a finite container, the lost-in-the-middle failure mode, and the two-step prompt chain baked into the investigation flow (diagnose → recommend).
- **03-retrieval-and-rag** — the honest answer here is *no RAG yet*. This sub-section covers the concepts as study material and lists concrete refactors that would add retrieval to the codebase (workspace schema retrieval, past-investigation memory, EQL query library).
- **04-agents-and-tool-use** — the strongest sub-section for this codebase. Five agent classes, the ReAct loop provided by `@aptkit/core`, tool calling shape, tool routing (categories/coverage gate), agent memory (short-term only), and error recovery via `is_error: true` observations.
- **05-evals-and-observability** — the live eval harness: 10 goldens across four signal classes, two rubrics (diagnosis + recommendation) with four dimensions each, LLM-as-judge with position/verbosity/self-preference guards, and the `AgentHooks.onCapabilityEvent` telemetry stream feeding cost + latency receipts.
- **06-production-serving** — prompt caching (measured: `cache_read_input_tokens` = 3168 in a real receipt), cost optimization (Haiku classifier + Sonnet agents), prompt injection defenses at the tool-schema boundary, rate limiting (~1 req/s Bloomreach ceiling), and retry/circuit-breaker patterns.
- **07-system-design-templates** — Search ranking and Tech support chatbot reframes. Neither directly applies; each file names the exact refactor that would let you defend blooming_insights as that template.

## The eval numbers you'll see cited

Baseline run: `runId 2026-07-03T04-08-28-644Z` (committed as `eval/baseline.json`).

- Per-phase p50 latency: diagnose 50s · diagnose-judge 38s · recommend 51s · recommend-judge 90s · total 225s
- Per-case cost: ~$0.09 agent-side (with caching); ~$1.30 total for the 10-case run
- Diagnosis pass rates: root_cause_plausibility 75% · evidence_grounding 50% · scope_coherence 75% · **actionable_next_step 0%** (systemic prompt gap the eval surfaced — worth calling out; the diagnostic agent never proposes actions)
- Recommendation pass rates: diagnosis_response 48% · feature_choice_fit 62% · step_actionability 100% · impact_realism 43%

## The known-broken thing the eval caught

Cases 01 and 08 both got "pause the A/B experiment" recommendations from the model, but in both cases the *primary* root cause is a payment processor failure. Pausing an experiment doesn't address a payment processor — so `diagnosis_response` scores 2 (fails). This isn't a hallucination; it's a recommendation-fit failure the rubric was designed to catch. It's the strongest interview receipt in the whole harness because you can point at exactly which rubric dimension caught which failure and why.

## What's not here

- **Classical ML.** No trained model, no feature engineering, no training data. Sub-sections 08 (machine learning) and 09 (ML system design templates) from the spec are skipped — they don't apply. The concepts covered in the spec are still worth knowing; they'd earn files if the codebase grows a trained classifier (e.g., an anomaly-severity classifier trained on historical judgments).
- **Retrieval.** No vector store, no embeddings, no chunking. Sub-section 03 covers the concepts and names the refactor path.

## Reading order

Start with **01-llm-foundations** for the interface-level model. Then **04-agents-and-tool-use** — that's where most of the codebase lives. Then **05-evals-and-observability** for the harness that keeps it honest. **02**, **03**, **06**, **07** in any order after that.
