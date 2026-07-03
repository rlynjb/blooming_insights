# AI features in this codebase

Every LLM-powered surface in blooming_insights, mapped to the pattern it uses and the file it lives in.

## The feature table

Six AI features. Five agents plus one classifier — all live over the same DataSource port, all traced through the same `AgentHooks.onCapabilityEvent` sink.

```
  ┌─────────────────────┬───────────────────┬────────────────────────────────┐
  │ Feature             │ Pattern           │ Where it lives                 │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ Monitoring scan     │ ReAct agent loop  │ lib/agents/monitoring.ts       │
  │ (anomaly detection) │  + tool routing   │ + @aptkit/core                 │
  │                     │  (categories gate)│                                │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ Diagnostic          │ ReAct agent loop  │ lib/agents/diagnostic.ts       │
  │ investigation       │  + prompt chain 1 │ + @aptkit/core                 │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ Recommendation      │ ReAct agent loop  │ lib/agents/recommendation.ts   │
  │ proposal            │  + prompt chain 2 │ + @aptkit/core                 │
  │                     │  (in from step 1) │                                │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ Free-form query     │ ReAct agent loop  │ lib/agents/query.ts            │
  │ (QueryBox)          │  + intent-routed  │ + @aptkit/core                 │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ Intent classifier   │ Single-chain,     │ lib/agents/intent.ts           │
  │                     │  cheap model      │ (Haiku 4.5)                    │
  ├─────────────────────┼───────────────────┼────────────────────────────────┤
  │ LLM-as-judge        │ Single-chain      │ eval/rubrics/*.ts              │
  │ (offline eval)      │  rubric scoring   │ (@aptkit/core RubricJudge)     │
  └─────────────────────┴───────────────────┴────────────────────────────────┘
```

Model choice: all agents run `claude-sonnet-4-6`. Intent classifier runs `claude-haiku-4-5-20251001`. Judge runs whatever `RUBRIC_JUDGE_MODEL` env resolves to — Sonnet by default.

## Per-feature spec

### Monitoring scan

- **Inputs:** `WorkspaceSchema` (project shape) + `AnomalyCategory[]` (which categories the schema can support, decided by `runnableCategories()` in `lib/agents/categories.ts:24`).
- **Outputs:** typed `Anomaly[]` — each anomaly has `metric`, `scope[]`, `change {value, direction, baseline}`, `severity`, `evidence[]`, and optional `impact`. Schema: `lib/mcp/types.ts:9-28`.
- **Model + provider:** Anthropic Sonnet 4.6 via `lib/agents/aptkit-adapters.ts` → `AnthropicModelProviderAdapter`.
- **Approx tokens per call:** ~12k input (schema summary + system prompt + tool defs) · ~1.5k output per turn · 3–7 turns per scan.
- **Failure modes observed:** overreach into scopes the schema can't support (handled by the coverage gate in `lib/agents/categories.ts`), rate limit collision at ~1 req/s (handled by `BloomreachDataSource` retry ladder).
- **Eval set:** ~none live — the monitoring output is upstream of the eval; anomalies are held constant across cases via `eval/goldens/*.ts`.

### Diagnostic investigation

- **Inputs:** one `Anomaly` + `WorkspaceSchema` + full MCP tool list.
- **Outputs:** typed `Diagnosis` — `conclusion`, `evidence[]`, `hypothesesConsidered[]` (with `supported: boolean`), optional `affectedCustomers`. Schema: `lib/mcp/types.ts:30-46`.
- **Model + provider:** Sonnet 4.6.
- **Approx tokens per call:** ~15k input · ~2k output per turn · 5–10 turns per investigation. With prompt caching (`lib/agents/aptkit-adapters.ts:75-98`), input tokens after turn 1 drop ~80%.
- **Failure modes observed:** eval receipt shows `actionable_next_step` scores 0% — the agent's prompt never asks it to propose actions, so the diagnosis is a plausible root cause with no "what to do about it." Prompt gap, not a model gap.
- **Eval set:** 10 goldens (`eval/goldens/01–10-*.ts`); baseline `eval/baseline.json` runId `2026-07-03T04-08-28-644Z`.

### Recommendation proposal

- **Inputs:** one `Anomaly` + the `Diagnosis` from step 2 + `WorkspaceSchema` + tool list.
- **Outputs:** `Recommendation[]` — each `{title, rationale, bloomreachFeature, steps[], estimatedImpact, confidence}`. Schema: `lib/mcp/types.ts:48-63`.
- **Model + provider:** Sonnet 4.6.
- **Approx tokens per call:** ~18k input · ~3k output per turn · 4–8 turns. Prompt caching same as diagnostic.
- **Failure modes observed:** cases 01 + 08 both propose "pause the A/B experiment" when the primary root cause is a payment processor — a recommendation-fit failure the `diagnosis_response` rubric catches (scores 2, fails). Overall `diagnosis_response` pass rate: 48%.
- **Eval set:** same 10 goldens, judged by the `recommendation-quality` rubric (`eval/rubrics/recommendation-quality.ts`).

### Free-form query

- **Inputs:** raw user text + a `QueryIntent` (from the intent classifier) + tool list.
- **Outputs:** natural-language answer string.
- **Model + provider:** Sonnet 4.6.
- **Approx tokens per call:** varies widely (~5k–20k input, 500–2k output).
- **Failure modes observed:** none formally evaluated; the eval harness does not include a query rubric.
- **Eval set:** none currently — a `query-quality` rubric would be a next add.

### Intent classifier

- **Inputs:** raw query text.
- **Outputs:** `QueryIntent` — one of the aptkit-defined intent tags.
- **Model + provider:** Haiku 4.5 (`claude-haiku-4-5-20251001`) via `lib/agents/intent.ts:16`.
- **Approx tokens per call:** ~500 input · ~50 output. Costs ~$0.0005 per call.
- **Failure modes observed:** `parseIntent()` defaults to `'diagnostic'` when the model returns something unparseable (`lib/agents/intent.ts:11`).
- **Eval set:** none — intent labels are internal routing, not user-facing.

### LLM-as-judge (offline)

- **Inputs:** rubric definition + agent output.
- **Outputs:** `RubricJudgment` — per-dimension score (1–5) + overall verdict (`pass` / `fail` / `unclear`) + rationale.
- **Model + provider:** typically Sonnet 4.6.
- **Approx tokens per call:** ~4k input · ~1k output. `max_tokens = 4096`. Judge-error resilience: on parse failure the receipt records a `judge_error` placeholder instead of crashing the run.
- **Failure modes observed:** occasional token cap hit on the recommendation rubric (long output list); mitigated by the `max_tokens = 4096` bump and the placeholder fallback.
- **Eval set:** blind calibration protocol (Session D pilot) — verdict 6/6 agreement, exact 13/24 (54%), within-1 24/24 (100%).

## The connective tissue

All six features share:

- **The `DataSource` port** (`lib/data-source/types.ts:64-73`) — no agent knows whether it's talking to MCP, Synthetic, or a FaultInjecting decorator. Five uses of the seam, zero caller-surface change.
- **The `AgentHooks` shape** (`lib/agents/diagnostic.ts:17-36`) — one hook interface flows through every agent. `onCapabilityEvent` feeds the observability report; `budget` feeds the pre-dispatch ceiling gate; `signal` propagates cancellation.
- **The prompt-caching cache breakpoint** (`lib/agents/aptkit-adapters.ts:75-98`) — one cache_control marker in the adapter; every agent benefits. Live measurement: `cache_read_input_tokens = 3168` on a real receipt (turn 2+ of a diagnostic run).
- **The `AnthropicModelProviderAdapter`** — one Anthropic SDK client wrapped once, used by every agent through aptkit's `ModelProvider` port. Swappable to any other provider without touching agents.

## Curriculum concept mapping

Roughly, in Phase order:

- **Phase 1** (LLM foundations): intent classifier, prompt caching, provider abstraction, token economics → sub-section 01.
- **Phase 2** (context + prompts): the diagnose → recommend chain → sub-section 02.
- **Phase 4** (agents): every ReAct agent → sub-section 04.
- **Phase 3** (evals): the harness → sub-section 05.
- **Phase 5** (production): rate limiting, retry, budget, injection defenses → sub-section 06.
