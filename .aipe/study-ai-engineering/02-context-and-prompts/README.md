# 02 — Context and prompts

The finite container everything else has to fit in, and the load-bearing pattern this repo actually exercises: chaining stages so each has one job.

## Files

- `01-context-window.md` — the finite container. In this repo the diagnostic loop grows the messages array across 5-10 turns; prompt caching absorbs most of the cost.
- `02-lost-in-the-middle.md` — the empirical attention pattern. Not directly measured in this codebase but shapes how we constrain tool_result content.
- `03-prompt-chaining.md` — the diagnose → recommend chain. Two agents, each with one job, sharing a `BudgetTracker`.

## Anchor shape

LLM application engineering (primary). The chain in `03-prompt-chaining.md` is the load-bearing pattern for this codebase — it's the diagnose → recommend split at the heart of the product.

## Curriculum

Phase 1 — concepts C1.2, prompt chaining.
