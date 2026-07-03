# AI features in this codebase

Every AI-touching thing in `blooming_insights`, with which pattern it uses and where it lives. The runtime is `@aptkit/core@0.3.0` (the ReAct loop, the tool-registry contract, the trace sink); the Blooming code owns the adapter bridge, the prompts (retired to `legacy-prompts/`; active prompts live inside AptKit), the tools (via MCP or synthetic), and the surrounding evals/observability.

## The features, at a glance

```
┌────────────────────────┬─────────────────┬────────────────────────────────────┐
│ Feature                │ Pattern          │ Anchor (file / class)              │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Monitoring anomaly scan│ Single-agent    │ MonitoringAgent → AptKit's         │
│                        │ tool-use loop   │ AnomalyMonitoringAgent             │
│                        │                 │ lib/agents/monitoring.ts           │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Diagnostic investigation│Single-agent    │ DiagnosticAgent → AptKit's         │
│                        │ tool-use loop   │ DiagnosticInvestigationAgent       │
│                        │ (≤6 tool calls) │ lib/agents/diagnostic.ts           │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Recommendation gen.    │ Single-agent    │ RecommendationAgent → AptKit's     │
│                        │ tool-use loop   │ RecommendationAgent                │
│                        │                 │ lib/agents/recommendation.ts       │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Diagnose → recommend   │ Prompt chain    │ eval/run.eval.ts:198-269           │
│ pipeline               │ (2-stage)       │ app/api/agent/route.ts             │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Free-form query        │ Single-agent    │ QueryAgent (AptKit)                │
│                        │ tool-use loop   │ lib/agents/query.ts                │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Intent classification  │ Heuristic +     │ classifyIntent, haiku-4-5          │
│                        │ cheap-LLM       │ lib/agents/intent.ts               │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Diagnosis-quality judge│ LLM-as-judge    │ RubricJudge (AptKit)               │
│                        │ (rubric)        │ eval/rubrics/diagnosis-quality.ts  │
├────────────────────────┼─────────────────┼────────────────────────────────────┤
│ Recommendation-quality │ LLM-as-judge    │ RubricJudge (AptKit)               │
│ judge                  │ (rubric)        │ eval/rubrics/recommendation-       │
│                        │                 │ quality.ts                         │
└────────────────────────┴─────────────────┴────────────────────────────────────┘
```

## Per-feature detail

The template each row fills: **Inputs · Outputs · Model + provider · Approx. cost per call · Failure modes · Eval set (size, where stored).**

### Monitoring anomaly scan

- **Inputs (typed):** `WorkspaceSchema` (project id, event catalog, customer properties, catalogs, totals) + `AnomalyCategory[]` (the fixed checklist of ecommerce anomaly categories from `@aptkit/core`'s `ECOMMERCE_ANOMALY_CATEGORIES`, wrapped in Blooming's `AnomalyCategory` shape via `lib/agents/categories.ts`).
- **Outputs (typed):** `Anomaly[]` — each has `{metric, scope[], change{value,direction,baseline}, severity, evidence[], impact?, history?, category?}`. Contract lives in `lib/mcp/types.ts`.
- **Model + provider:** Anthropic `claude-sonnet-4-6` via `AnthropicModelProviderAdapter` (`lib/agents/aptkit-adapters.ts`).
- **Approx. cost per call:** monitoring is ~1 model turn per anomaly-worth of tool calls; a full briefing is ~4-5 turns × ~1-2K input / ~500 output tokens each. Estimated cost per briefing: ~$0.02-0.05 uncached, ~$0.005-0.015 with prompt caching.
- **Failure modes observed:** rate limit against the alpha Bloomreach MCP server (~1 req/s), token revocation mid-scan (auto-reconnect on the UI). No hallucination-of-numbers reported at eval time — the ecommerce-category checklist keeps the agent from inventing metrics.
- **Eval set:** monitoring itself is not gated by the harness in `eval/run.eval.ts` (which evaluates `diagnose + recommend` against synthetic anomalies). Monitoring surfaces are exercised end-to-end via the committed demo snapshot (`lib/state/demo-*.json`).

### Diagnostic investigation

- **Inputs (typed):** one `Anomaly` (from monitoring) + `WorkspaceSchema` + full MCP tool catalog.
- **Outputs (typed):** `Diagnosis` = `{conclusion, evidence[], hypothesesConsidered[{hypothesis, supported, reasoning}], affectedCustomers?, confidence?}`. Contract lives in `lib/mcp/types.ts`.
- **Model + provider:** Anthropic `claude-sonnet-4-6` via `AnthropicModelProviderAdapter`.
- **Approx. cost per call:** eval-measured at ~$0.03-0.05 per diagnosis (cached, from receipts in `eval/receipts/`). Median ~10 model turns, ~50s p50 wall time.
- **Failure modes observed:** the biggest one in the committed baseline is `actionable_next_step` at 0% pass rate (dim 4 of the diagnosis rubric) — the agent's conclusions rarely include a specific named next step with a tool/query. `evidence_grounding` at 50% is the next largest — agent sometimes states conclusions that trace back only weakly to the tool results.
- **Eval set:** 10 goldens (has-signal / partial-signal / no-signal / positive) in `eval/goldens/`, rubric in `eval/rubrics/diagnosis-quality.ts`. Committed baseline: `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`).

### Recommendation generation

- **Inputs (typed):** `Anomaly` + `Diagnosis` + `WorkspaceSchema` + full MCP tool catalog. Note: RecommendationAgent receives the diagnosis and can call tools to enrich (segment sizes, campaign lists) before proposing.
- **Outputs (typed):** `Recommendation[]` — each has `{id, title, rationale, bloomreachFeature: scenario|segment|campaign|voucher|experiment, steps[], estimatedImpact, confidence}`.
- **Model + provider:** Anthropic `claude-sonnet-4-6` via `AnthropicModelProviderAdapter`.
- **Approx. cost per call:** ~$0.04-0.06 per recommendation set. Median p50 wall time 51s.
- **Failure modes observed:** in the baseline — `impact_realism` at 43% pass rate is the lowest. Rec impact estimates are frequently disproportionate to the anomaly magnitude or missing the linking assumption. `diagnosis_response` at 48% — recs sometimes address a symptom instead of the diagnosed root cause. `step_actionability` at 100% is the strong one (steps are specific enough to execute).
- **Eval set:** same 10 goldens as diagnosis; rubric in `eval/rubrics/recommendation-quality.ts`.

### The diagnose → recommend chain

- **Pattern:** prompt chain — output of diagnostic agent (a `Diagnosis`) becomes input to recommendation agent, along with the original anomaly. Two sequential agent invocations, each with its own tool-use loop, sharing an investigation's `BudgetTracker`.
- **Where it lives:** the eval runner walks it explicitly (`eval/run.eval.ts:198-269`); the route handler at `app/api/agent/route.ts` walks it stage-by-stage based on the `step=diagnose|recommend|null` param.
- **Why chain not one big agent:** each stage has one job (diagnose the cause, propose the action) — the failures are isolated, the trace surfaces are separable, and either stage can be swapped independently. The recommendation stage receives the diagnosis's structured conclusion as context, not the diagnostic agent's whole tool-call trace.
- **Cost:** ~$0.09/case total in the committed baseline (agent-side, cached).

### Free-form query (natural-language Q&A)

- **Pattern:** single-agent tool-use loop with a broader tool set than diagnostic.
- **Inputs:** a free-form text query + `WorkspaceSchema` + full MCP tool catalog.
- **Outputs:** streamed text response with cited tool calls.
- **Model:** Anthropic `claude-sonnet-4-6`.
- **Where it lives:** `lib/agents/query.ts` (thin wrapper) → `@aptkit/core`'s `QueryAgent`. Surfaced via `QueryBox` (bottom of feed).
- **Live only.** In demo mode the `QueryBox` is shown but inert.

### Intent classification (query router)

- **Pattern:** heuristic-before-LLM (spec's "heuristic-before-LLM" concept, though today it's LLM-only using a cheaper model — Haiku).
- **Inputs:** raw user query string.
- **Outputs:** `Intent` (currently one of `'diagnostic'` etc., re-exported from `@aptkit/core`'s `QueryIntent`).
- **Model + provider:** Anthropic `claude-haiku-4-5-20251001` — deliberately the cheap fast model, since intent classification is one turn and doesn't need Sonnet's reasoning depth.
- **Approx. cost per call:** ~$0.0001-0.0005 per classify.
- **Where it lives:** `lib/agents/intent.ts` (thin adapter around AptKit's `classifyIntent`).

### Diagnosis-quality LLM-as-judge

- **Pattern:** LLM-as-judge with a rubric (4 dimensions × 1-5 scale × 3 verdicts).
- **Inputs:** the diagnosis JSON to score + context (the anomaly, the golden case's `knownCorrect` notes, the tool-call trace, the signal class).
- **Outputs:** `{dimensions: {dim → {score, reason}}, verdict, fix, reasoning}`.
- **Model:** Anthropic `claude-sonnet-4-6` — same model as the agent-under-test. Known self-preference bias risk (see `05-evals-and-observability/03-llm-as-judge-bias.md`). Session D pilot ran a Haiku judge for calibration.
- **Approx. cost per call:** ~$0.04 per judgment (maxTokens=4096, no cache — each case has different context).
- **Failure modes:** in the baseline, the diagnosis judge had 6/10 `judge_error` verdicts (model failed to produce parseable structured output within budget). Placeholder-verdict handling in `eval/run.eval.ts:82-108` prevents these from crashing the run.

### Recommendation-quality LLM-as-judge

Same shape as the diagnosis judge, different rubric. Scores each recommendation independently (baseline had 30 total judgments across 10 cases; 9 were `judge_error`).

## The DataSource seam (not a feature but load-bearing)

The seam that makes swapping between live Bloomreach, synthetic evals, and fault-injected load tests possible without any agent code changing. `BloomreachDataSource` (live MCP), `SyntheticDataSource` (deterministic in-memory), `FaultInjectingDataSource` (offline decorator). All conform to `DataSource` in `lib/data-source/types.ts`. See `04-agents-and-tool-use/02-tool-calling.md` for the walkthrough.

## What's NOT in this table

- No RAG feature. No embeddings, no vector store.
- No trained model. Every "reasoning" step is an LLM call.
- No semantic cache. Prompt caching (Anthropic ephemeral) IS live; semantic caching is not.
- No fine-tuned model. Base Sonnet 4.6 out of the box.
