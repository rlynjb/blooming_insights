# 01 — LLM foundations

The layer beneath everything else in this repo. Every agent, every eval, every cost line traces back to what an LLM is (a next-token predictor with an interface), how tokens shape context and cost, how sampling parameters change output shape, and how the boundary at the model — structured outputs, streaming, provider abstraction — determines what's easy or hard downstream.

## Files (read in order)

- `01-what-an-llm-is.md` — the IO model, before the architecture. Every bug story ends with "we thought the model was doing X."
- `02-tokenization.md` — text becomes tokens. Context windows are sized in tokens. Cost is measured in tokens.
- `03-sampling-parameters.md` — temperature, top-p, top-k. This codebase uses `temperature: 0` on the judge; agents use AptKit's defaults.
- `04-structured-outputs.md` — the tool-call schema is the only output path (`Anomaly`, `Diagnosis`, `Recommendation`). No free-form JSON parsing.
- `05-streaming.md` — NDJSON `AgentEvent` stream. First-token latency drops the perceived wait.
- `06-token-economics.md` — the cost ledger. Per-case ~$0.09 (agent-side, cached). Per 10-case run ~$1.30.
- `07-heuristic-before-llm.md` — partially exercised: intent uses Haiku (cheap-LLM) not heuristic regex. Case B project exercise.
- `08-provider-abstraction.md` — the `ModelProvider` port from AptKit + `AnthropicModelProviderAdapter` in this repo. One swap point.
- `09-user-override-locks.md` — not exercised. There are no user-editable fields the agent re-classifies. Case B project exercise.

## Anchor shape

LLM application engineering (primary shape). Every file here is directly exercised in `blooming_insights` except `07` (partial), `09` (not present).

## Curriculum

Phase 1 — concepts C1.1-C1.14.
