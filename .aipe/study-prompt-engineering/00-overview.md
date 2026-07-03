# Overview — the prompt surface of this repo

The whole system on one page, so every concept file after this one has a place to hang off.

## The system in one diagram

```
  blooming_insights — prompt surface

  ┌─ UI layer ─────────────────────────────────────────────────────────┐
  │  Next.js pages · streams NDJSON from route handlers                 │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  fetch('/api/agent'), fetch('/api/briefing')
  ┌─ Service layer ────────▼───────────────────────────────────────────┐
  │  app/api/agent/route.ts   ← query intent + free-form Q&A            │
  │  app/api/briefing/route.ts ← full monitor→diagnose→recommend chain  │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  invokes agent classes
  ┌─ Agent layer (system prompts live INSIDE the @aptkit/core classes) ─┐
  │  MonitoringAgent   → AptKitAnomalyMonitoringAgent (system prompt)    │
  │  DiagnosticAgent   → AptKitDiagnosticInvestigationAgent  (sys prompt)│
  │  RecommendationAgent → AptKitRecommendationAgent          (sys prompt)│
  │  (Legacy prompts preserved in lib/agents/legacy-prompts/*.md          │
  │   as a rollback receipt — not on the live path)                      │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  ModelProvider.complete(system, messages, tools)
  ┌─ Provider adapter ─────▼───────────────────────────────────────────┐
  │  AnthropicModelProviderAdapter                                      │
  │    · wraps request.system in cache_control: ephemeral               │
  │    · calls anthropic.messages.create()                              │
  │    · logs usage; feeds BudgetTracker                                │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  MCP tool calls (out-of-band from prompt)
  ┌─ Data layer ───────────▼───────────────────────────────────────────┐
  │  Bloomreach MCP server (or SyntheticDataSource in eval)             │
  │    · results validated at lib/mcp/validate.ts on the way back       │
  │    · truncated to 4000 chars in eval/route traces                   │
  └────────────────────────────────────────────────────────────────────┘

  Sidecar — the eval harness (runs the whole pipeline against 10 goldens)

  ┌─ eval/run.eval.ts ─────────────────────────────────────────────────┐
  │  for each golden case:                                              │
  │    diagnose → RubricJudge(diagnosisQualityRubric)                   │
  │    recommend → RubricJudge(recommendationQualityRubric) per rec     │
  │  writes eval/receipts/<caseId>-<runId>.json                        │
  └────────────────────────────────────────────────────────────────────┘
```

Every concept file below points at one of these boxes. Anatomy (01) is what lives inside the agent-class system prompt. Structured outputs (02) is the validator on the way back. Prompts as code (03) is the legacy markdown + the aptkit-owned live path. Token budgeting (04) is schemaSummary + prompt caching + tool-result truncation. Eval-driven iteration (05) is the sidecar harness. And so on.

## Two things to know before you read anything else

**The prompts are not where you might expect them.** `lib/agents/legacy-prompts/*.md` looks like the live path. It isn't. Those are receipts — the last string-format prompts kept in the repo as a rollback anchor. The active system prompts live inside `@aptkit/core`'s `AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, and `RecommendationAgent` classes. The blooming code shapes them by passing the workspace schema, the categories, and (for diagnose) the anomaly as request-time context; the agent classes assemble the actual system prompt inside `complete()`. This split matters because it means "iterating on the prompt" now happens in two places — the aptkit package for structure, blooming for context.

**Prompt caching is on and load-bearing.** `AnthropicModelProviderAdapter.complete()` wraps `request.system` in `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`. Within an investigation (~10 model turns for a diagnosis), the first call is a cache_creation and the rest are cache_reads. In the baseline run — `2026-07-03T04-08-28-644Z` — live logs show cache_read_input_tokens landing at 3168 within a single investigation. That single line of code is roughly the difference between "cheap enough to run 10 goldens on every prompt change" and "run it once a week and hope."

## Numbers you'll see cited across the files

From the baseline run `2026-07-03T04-08-28-644Z` (Synthetic goldens, claude-sonnet-4-6):

- **Diagnose:** avg ~7,404 input tokens, ~1,858 output tokens per case.
- **Recommend:** avg ~1,384 input tokens, ~2,468 output tokens per case.
- **Judgment stability:** the same anomaly can score `root_cause_plausibility` at 4 in one run and 5 in another. Judge variance is real; you learn to plan for it.
- **Rec anti-pattern surfaced:** on has-signal cases where the diagnosis correctly named "payment processor," the recommendation would sometimes propose "pause the A/B experiment" (which was named in the diagnosis as a secondary contributor). Judged `fail` on `diagnosis_response = 2`. Case 04 receipt has the trace.

These are the numbers concept files reach for when the question is "does this actually matter."

## See also

- 01 — the anatomy of the prompts in this repo, section by section.
- 03 — how the legacy prompts became the live-path prompts and what that split cost.
- 05 — how the numbers above were produced and what they tell you.
