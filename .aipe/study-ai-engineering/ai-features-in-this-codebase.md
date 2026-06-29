# AI features in this codebase

The actual AI features this repo runs in production. Each feature is one of the five Blooming-owned agents — a thin wrapper around `@aptkit/core@0.3.0`'s reusable agent — plus the intent classifier that gates the free-form question surface.

The shape: **LLM application engineering.** No ML models, no embeddings, no trained classifiers. Every "feature" here is an LLM call with a tool surface and a structured-output contract.

## The feature table

```
  ┌──────────────────────┬──────────────────┬──────────────────────────────────┐
  │ Feature              │ Pattern used     │ Why this pattern                 │
  ├──────────────────────┼──────────────────┼──────────────────────────────────┤
  │ Monitoring scan      │ Tool-using agent │ open-ended search across the    │
  │                      │ + schema gating  │ 10-category checklist; agent    │
  │                      │                  │ decides which EQL to run         │
  ├──────────────────────┼──────────────────┼──────────────────────────────────┤
  │ Diagnostic           │ Tool-using agent │ multi-hop investigation; each   │
  │ investigation        │ + hypothesis     │ EQL informs the next query       │
  │                      │ testing          │                                  │
  ├──────────────────────┼──────────────────┼──────────────────────────────────┤
  │ Recommendation       │ Tool-using agent │ proposes Bloomreach actions     │
  │ proposal             │ + structured     │ as typed Recommendation[] —     │
  │                      │ output           │ steps, confidence, impact        │
  ├──────────────────────┼──────────────────┼──────────────────────────────────┤
  │ Free-form query      │ Tool-using agent │ user asks anything; agent runs  │
  │                      │ + intent routing │ EQL to answer with citations    │
  ├──────────────────────┼──────────────────┼──────────────────────────────────┤
  │ Intent               │ Cheap-model      │ Haiku decides which downstream  │
  │ classification       │ classifier       │ agent the query belongs to —    │
  │                      │ (Heuristic-      │ saves a full Sonnet agent run    │
  │                      │ before-LLM at    │ on out-of-scope questions        │
  │                      │ the intent layer)│                                  │
  └──────────────────────┴──────────────────┴──────────────────────────────────┘
```

The four `Sonnet` agents all use the same model (`claude-sonnet-4-6`) and the same ReAct loop inside AptKit. The only differences are: (a) the system prompt, (b) the allowed tool subset, and (c) the structured output type. The intent classifier is the lone use of `claude-haiku-4-5-20251001` (`lib/agents/intent.ts:16`).

## Per-feature specs

### 1. Monitoring scan — detect anomalies in the workspace

  → **File:** `lib/agents/monitoring.ts` (116 LOC). Wraps `AptKitAnomalyMonitoringAgent`.
  → **Inputs (typed schema):** `WorkspaceSchema` (the bootstrapped workspace at `lib/mcp/schema.ts:9-26`), `AnomalyCategory[]` (the runnable subset of the 10-category checklist, post-gating, from `lib/agents/categories.ts:CATEGORIES`).
  → **Outputs (typed schema):** `Anomaly[]` (`lib/mcp/types.ts:80-91`). Each anomaly carries `metric`, `scope[]`, `change{value,direction,baseline}`, `severity`, `evidence[]`, optional `impact`, `history[]`, `category`.
  → **Model and provider:** `claude-sonnet-4-6` via Anthropic SDK (`AGENT_MODEL` at `lib/agents/base.ts:7`).
  → **Tool surface:** `monitoringTools` at `lib/mcp/tools.ts:6-14` — 13 tools (`execute_analytics_eql` is the workhorse; the rest are list/get tools for dashboards, trends, funnels, etc.).
  → **Approximate token cost per call:** system prompt + schema summary ≈ 800–1200 input tokens before any tool calls. Each `tool_call_end` feeds back the (truncated to 4KB) result. A typical scan runs 6 tool calls × ~2k tokens each = ~12–15k input tokens, ~1–2k output. At Sonnet pricing: ~$0.05–$0.08 per scan.
  → **Failure modes observed:**
    - The 90-day window lands on the workspace's sparse tail → bogus ±100% swings (the schema prompt at `lib/agents/legacy-prompts/monitoring.md:26-36` is explicitly defended against this).
    - Agent exceeds the 6-call budget → forced to answer with whatever it has (built-in to the AptKit loop).
    - Bloomreach rate-limit during a scan → retry with parsed window adds up to 30s of latency.
  → **Eval set:** retired. The Phase 3 4-pillar suite (detection / diagnosis / recommendation / regression) was built on Olist data and retired in PR #8 (2026-06-18). The next version targets `SyntheticDataSource`.

### 2. Diagnostic investigation — explain why an anomaly happened

  → **File:** `lib/agents/diagnostic.ts` (49 LOC). Wraps `AptKitDiagnosticInvestigationAgent`.
  → **Inputs (typed schema):** `Anomaly` (the monitoring agent's output, handed in via `app/api/agent/route.ts:264` after resolution from session/cache/snapshot).
  → **Outputs (typed schema):** `Diagnosis` (`lib/mcp/types.ts:93-103`). Carries `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers`, `confidence`, `timeSeries[]`.
  → **Model and provider:** `claude-sonnet-4-6` (same as monitoring).
  → **Tool surface:** `diagnosticTools` at `lib/mcp/tools.ts:16-26` — 17 tools (EQL + segmentation + customer lookups + campaign/experiment list tools).
  → **Approximate token cost per call:** ~15–20k input tokens (system prompt + schema summary + anomaly handoff + tool results) across ~5–8 tool calls. ~$0.07–$0.10 per investigation.
  → **Failure modes observed:**
    - Agent runs out of budget mid-hypothesis → returns a partial diagnosis with `confidence: 'medium'` or `'low'` (derivable client-side via `diagnosisConfidence()` at `lib/insights/derive.ts:53`).
    - All hypotheses come back `supported: false` → `conclusion` says "no single cause identified"; the UI surfaces this directly.
    - The Phase 3 eval surfaced **conclusion instability**: 30% of runs reached different conclusions on the same anomaly. Retired with the suite.
  → **Eval set:** retired (same as monitoring).

### 3. Recommendation proposal — convert diagnosis into Bloomreach actions

  → **File:** `lib/agents/recommendation.ts` (40 LOC). Wraps `AptKitRecommendationAgent`.
  → **Inputs (typed schema):** `Anomaly` + `Diagnosis` (handed in via `app/api/agent/route.ts:296`).
  → **Outputs (typed schema):** `Recommendation[]` (`lib/mcp/types.ts:117-131`). Each carries `id`, `title`, `rationale`, `bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment'`, `steps[]`, `estimatedImpact`, `confidence`. Optional enrichments: `effort`, `timeToSetUpMinutes`, `readResultInDays`, `prerequisites[]`, `successMetric`.
  → **Model and provider:** `claude-sonnet-4-6`.
  → **Tool surface:** `recommendationTools` at `lib/mcp/tools.ts:28-36` — 7 tools (list scenarios, initiatives, segmentations, campaigns, voucher pools, frequency policies).
  → **Approximate token cost per call:** ~10–15k input tokens, ~1.5–3k output (recommendations are verbose). ~$0.05–$0.09 per proposal.
  → **Failure modes observed:**
    - `bloomreachFeature` defaults to `'scenario'` when the agent isn't confident — surfaces as generic recommendations.
    - The Phase 3 eval surfaced **binary calibration**: model rated 29 of 30 runs as `confidence: 'high'`, clearly miscalibrated. Retired with the suite.
  → **Eval set:** retired (same as monitoring).

### 4. Free-form query — answer any question about the workspace

  → **File:** `lib/agents/query.ts` (34 LOC). Wraps `AptKitQueryAgent`.
  → **Inputs (typed schema):** `query: string` (the user's free-form question), `intent: Intent` (output of the intent classifier).
  → **Outputs:** Plain `string` (natural-language answer). The agent may cite EQL it ran along the way (visible in the `StatusLog` panel via the tool-call trace).
  → **Model and provider:** `claude-sonnet-4-6`.
  → **Tool surface:** `queryTools` at `lib/mcp/tools.ts:43-45` — the union of monitoring + diagnostic + recommendation tools (so the agent can answer anything across the three surfaces).
  → **Approximate token cost per call:** wide variance — a one-sentence answer might cost ~5k tokens; a multi-tool investigation that re-derives an anomaly costs ~15–20k. ~$0.02–$0.10.
  → **Failure modes observed:**
    - User asks something outside the workspace's data → agent runs an empty query, returns "I couldn't find anything matching that."
    - Prompt injection surface: the user's question is concatenated into the agent's prompt. Defense is structural (the agent can only call MCP tools, no arbitrary actions); see `06-production-serving/03-prompt-injection.md`.
  → **Eval set:** none. The free-form query agent has no eval today.

### 5. Intent classification — cheap classifier in front of the query agent

  → **File:** `lib/agents/intent.ts` (38 LOC). Wraps `classifyAptKitIntent` from `@aptkit/core`.
  → **Inputs (typed schema):** `query: string`.
  → **Outputs (typed schema):** `Intent` = `QueryIntent` from `@aptkit/core` — one of a fixed enum, defaulting to `'diagnostic'` via `parseIntent` (`lib/agents/intent.ts:13`).
  → **Model and provider:** `claude-haiku-4-5-20251001` — the cheap, fast Anthropic model. The ONLY non-Sonnet use in the codebase.
  → **Tool surface:** none — intent classification is a single completion call, no tool loop.
  → **Approximate token cost per call:** ~500 input tokens, ~10 output. At Haiku pricing: ~$0.0003 per classification — negligible.
  → **Failure modes observed:**
    - Ambiguous query → defaults to `'diagnostic'` (the parser's fallback at `lib/agents/intent.ts:13`).
    - Haiku occasionally returns non-enum text → `parseIntent` swallows it and uses the default.
  → **Eval set:** none today.

## What's NOT a feature

Things that look like AI features but aren't, in this codebase:

  → **The 10-category checklist** at `lib/agents/categories.ts:CATEGORIES`. That's rule-based gating, not AI — it's a fixed list of anomaly categories the monitoring agent is *allowed* to check, derived from `@aptkit/core`'s `ECOMMERCE_ANOMALY_CATEGORIES`. The AI part is the agent deciding *what to do* within a runnable category, not the category list itself.
  → **The schema-gating layer** at `lib/agents/categories.ts:24` (`coverageFor`, `runnableCategories`). Set intersection — does the workspace's schema expose the events this category requires? Pure rules.
  → **The 60s response cache** at `lib/data-source/bloomreach-data-source.ts:140`. Standard request-level cache, nothing AI about it.
  → **The demo replay** at `app/api/briefing/route.ts:81-152`. Replays a committed NDJSON snapshot as if it were live. Looks like AI from the UI; it's a static file getting fed back through the same stream contract.

These are deliberate. The agents handle the open-ended decisions; the rules handle everything that has a right answer.

## Where to read each feature's deep walk

  → Monitoring's loop, structured outputs, tool surface → `04-agents-and-tool-use/`
  → Diagnostic's hypothesis-testing pattern → `04-agents-and-tool-use/03-react-pattern.md`
  → Recommendation's structured output → `01-llm-foundations/04-structured-outputs.md`
  → Free-form query's intent routing → `04-agents-and-tool-use/04-tool-routing.md`
  → Intent's heuristic-before-LLM at the intent layer → `01-llm-foundations/07-heuristic-before-llm.md`
