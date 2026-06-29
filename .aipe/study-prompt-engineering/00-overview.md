# Overview — the prompt-engineering surface of blooming insights

**Industry standard** · system overview, prompt-engineering lens

## Zoom out — where prompts live in this system

blooming insights runs four LLM-backed agents (monitoring, diagnostic, recommendation, query) plus a one-token intent classifier. Every one of them has a system prompt template stored as markdown in the repo; every one of them validates the model's output at a typed boundary before the rest of the app touches it. The diagram below pins those two surfaces — prompts in, structured output out — across the stack.

```
  Zoom out — the prompt-engineering surface

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  app/page.tsx · components/chat/QueryBox.tsx              │
  │  user-controlled text enters HERE                         │
  └─────────────────────────────────┬─────────────────────────┘
                                    │  POST /api/agent { q }
  ┌─ API route layer ────────────────▼────────────────────────┐
  │  app/api/agent/route.ts · app/api/briefing/route.ts        │
  │  picks the agent · streams NDJSON                          │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─ ★ PROMPT LAYER ★ ──────────────▼────────────────────────┐ ← we are here
  │  system prompt templates:                                  │
  │    lib/agents/legacy-prompts/{monitoring,diagnostic,       │
  │                              recommendation,query}.md      │
  │  slot interpolation: {schema}, {project_id}, {categories}, │
  │                      {anomaly}, {diagnosis}, {intent}      │
  │  active wrapping: @aptkit/core (consumes the same patterns)│
  └─────────────────────────────────┬─────────────────────────┘
                                    │  text in → text out
  ┌─ Model + MCP layer ─────────────▼────────────────────────┐
  │  Anthropic (claude-sonnet-4-6 / haiku-4-5 for intent)      │
  │  tool registry: lib/mcp/tools.ts (per-agent allowlists)    │
  │  per-result truncation: lib/agents/base-legacy.ts:34       │
  └─────────────────────────────────┬─────────────────────────┘
                                    │  JSON in a ```json fence
  ┌─ Validator layer ───────────────▼────────────────────────┐
  │  defensive parser:  parseAgentJson  (lib/mcp/validate.ts) │
  │  type guards:       isAnomalyArray · isDiagnosis ·         │
  │                     isRecommendationArray                  │
  └─────────────────────────────────┬─────────────────────────┘
                                    │  typed `Anomaly[]` / `Diagnosis` / ...
  ┌─ State + UI ────────────────────▼────────────────────────┐
  │  rendered as InsightCard, EvidencePanel, RecommendationCard│
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this notebook covers

Thirteen concepts, organized so the operational discipline (anatomy, structured outputs, prompts-as-code, token budgeting, eval-driven iteration) comes before the specific techniques (few-shot, chain-of-thought, self-critique, meta-prompting). Two concepts cover specific failure modes (output mode mismatch, prompt injection); one covers a pattern this repo doesn't yet exercise (forbidden patterns / rotating formulas).

Every concept anchors to real code:

  → prompt templates at `lib/agents/legacy-prompts/*.md`
  → the schema-compaction helper (`schemaSummary`) at `lib/agents/monitoring.ts:19`
  → the tool registry at `lib/mcp/tools.ts`
  → the defensive parser (`parseAgentJson`) at `lib/mcp/validate.ts:3`
  → the type guards at `lib/mcp/validate.ts:17-57`
  → the per-result truncation at `lib/agents/base-legacy.ts:32-37`
  → token usage logging at `lib/agents/aptkit-adapters.ts:57-61`

## The five agents at a glance

```
  Five agents, five system prompts — each with one job

  ┌─ classifier ─────────────────────────────────────────────┐
  │  intent (haiku-4-5)                                       │
  │    one-token output: monitoring | diagnostic |            │
  │                      recommendation                       │
  │    16 max_tokens · no tools · 1 SDK call                  │
  └───────────────────────────────────────────────────────────┘

  ┌─ monitoring ─────────────────────────────────────────────┐
  │  monitoring (sonnet-4-6)                                  │
  │    output: JSON array of Anomaly{} (in ```json fence)     │
  │    6 tool calls max · execute_analytics_eql + catalog     │
  │    isAnomalyArray() validates · UI renders as cards       │
  └───────────────────────────────────────────────────────────┘

  ┌─ diagnostic ─────────────────────────────────────────────┐
  │  diagnostic (sonnet-4-6)                                  │
  │    output: JSON object Diagnosis{} (in ```json fence)     │
  │    6 tool calls max · segments + time-series              │
  │    isDiagnosis() validates · UI renders as EvidencePanel  │
  └───────────────────────────────────────────────────────────┘

  ┌─ recommendation ─────────────────────────────────────────┐
  │  recommendation (sonnet-4-6)                              │
  │    output: JSON array Recommendation[] (in ```json fence) │
  │    4 tool calls max · Bloomreach feature catalog          │
  │    isRecommendationArray() validates · UI renders cards   │
  └───────────────────────────────────────────────────────────┘

  ┌─ query (free-form Q&A) ──────────────────────────────────┐
  │  query (sonnet-4-6)                                       │
  │    output: plain prose (NO json contract)                 │
  │    ~6 tool calls · superset registry                      │
  │    no validator · streamed straight to the UI             │
  └───────────────────────────────────────────────────────────┘
```

Four of the five are JSON-structured outputs; one (the query agent) returns prose. That asymmetry shows up in every concept that follows — structured-output discipline applies to four agents, doesn't apply to one. Worth holding that contrast in your head as you read.

## What the codebase is missing (the honest list)

Two concepts get a "not yet exercised" treatment:

  → **Eval-driven iteration with a real eval set.** The validator (`lib/mcp/validate.ts`) tests shape, not behavior. There's no golden set of (prompt, input, expected output) cases. The eval/ folder was retired (PR #8). Concept #5 covers what this means and what a buildable target looks like.
  → **Rotating formulas / forbidden patterns.** No agent in this codebase is a generative chain run repeatedly for the same user, so the pattern doesn't fire here yet. Concept #13 covers when it would.

The rest of the concepts have real anchors in real files. Read on.
