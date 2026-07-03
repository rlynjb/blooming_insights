# AI engineering — overview

## Zoom out — the shape of AI work in this repo

```
  blooming_insights — where AI actually sits

  ┌─ UI layer (Next.js 16 App Router) ─────────────────────────────────┐
  │  app/page.tsx  ·  app/investigate/[id]/page.tsx                     │
  │  StatusLog  ·  InsightCard  ·  EvidencePanel  ·  RecommendationCard │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │  fetch → NDJSON stream (AgentEvent)
  ┌─ Route layer (Next.js) ─────▼───────────────────────────────────────┐
  │  app/api/briefing/route.ts    (monitoring scan)                     │
  │  app/api/agent/route.ts       (diagnose | recommend | query)        │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │  invoke agent → hooks stream traces
  ┌─ Agent layer (AptKit + Anthropic) ★ THIS IS AI ★ ───────────────────┐
  │  MonitoringAgent → DiagnosticAgent → RecommendationAgent            │
  │  · Model provider: Anthropic (claude-sonnet-4-6, haiku for intent)  │
  │  · Loop:           @aptkit/core (ReAct-shaped tool-use loop)        │
  │  · Bridge:         lib/agents/aptkit-adapters.ts (263 LOC)          │
  │  · Prompt cache:   ephemeral breakpoint on system prompt            │
  │  · Budget gate:    per-investigation ceiling (BudgetTracker)        │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │  callTool(name, args) via DataSource
  ┌─ DataSource seam (the port) ▼───────────────────────────────────────┐
  │  BloomreachDataSource   → live MCP (rate-limited, ~1 req/s)         │
  │  SyntheticDataSource    → deterministic in-memory fixture (evals)   │
  │  FaultInjectingDataSource → offline decorator (load + fault tests)  │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │  MCP tools (EQL) / synthetic tables
                                ▼
                       ecommerce workspace data
```

## Which of the three AI shapes this is

Three shapes the AI engineering spec recognizes: LLM application engineering, prompt engineering / meta-tooling, classical ML. `blooming_insights` is squarely the first one.

- LLM application engineering — YES. Multi-agent orchestration (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, intent classifier) built on `@aptkit/core`'s ReAct-shaped tool-use loop, streamed to the UI as NDJSON, with an eval harness (10 goldens × 2 rubrics × 4 dimensions) and a regression gate.
- Prompt engineering — present but not the primary discipline. Retired system prompts live in `lib/agents/legacy-prompts/`; the active runtime uses AptKit's built-in agent prompts. The prompt work here is inherited more than authored.
- Classical ML — NO. No trained model, no training pipeline, no feature engineering. Every "reasoning" step is an LLM call.

The rest of this guide treats the repo as LLM application engineering. Sub-section 08 (Machine Learning) is generated honestly — most concepts are marked "not exercised" because they aren't. Sub-section 09 (ML system-design templates) walks through the templates as required by spec, with "Applies" set to `no` where they don't fit and "How to make it apply" naming the concrete refactor.

## What's load-bearing in this codebase (rank order)

Not every concept in this guide is equal weight for this repo. The load-bearing ones — where interview signal and current portfolio value concentrate — are:

1. **The eval harness** (`eval/`) — 10 goldens × 2 rubrics × 4 dims × 3 verdicts, per-case receipt, judge-error resilience, signal-class-aware gate, calibration slice, load harness, fault-injection decorator, regression gate. This is the tier-2 story.
2. **Multi-agent orchestration on AptKit** (`lib/agents/`) — `@aptkit/core@0.3.0` owns the ReAct loop; the repo owns the 263-LOC bridge (`aptkit-adapters.ts`) that wires Anthropic + Blooming's tool-registry + trace hooks into AptKit's ports.
3. **Prompt caching + budget ceiling** (`AnthropicModelProviderAdapter`, `BudgetTracker`) — every `complete()` call wraps the system prompt in an ephemeral cache breakpoint (~80% cost reduction on the system-prompt prefix) and checks a per-investigation cost ceiling BEFORE dispatching.
4. **The DataSource seam** (`lib/data-source/`) — the port that survived two adapter swaps (Olist added → removed, Synthetic added) and now carries a third decoration in `FaultInjectingDataSource`. The seam is what makes the eval and load harnesses possible.
5. **NDJSON streaming of agent reasoning** (`app/api/*/route.ts` → `StatusLog`) — the product's pitch ("an analyst that shows its work") reduces to a stream of `reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation` events. Agent trace is a first-class UI surface.

## What the codebase does NOT exercise

Being honest about this is part of the guide's job. The reader shouldn't defend patterns that aren't in the repo.

- **RAG.** Not present. No embeddings, no vector store, no chunking. The agents query structured event/customer data via MCP tools, not text over vectors. Sub-section 03 files are generated as "concept only, not exercised" per spec.
- **Semantic caching.** Prompt caching (Anthropic ephemeral breakpoint) is live; semantic caching over query embeddings is not.
- **Trained ML.** No supervised learning, no model artifacts, no train/val/test discipline. Sub-section 08 is largely "not exercised."
- **Rate limiting on the outbound side.** The `BloomreachDataSource` has a ~1 req/s proactive spacing + retry ladder INBOUND (protecting the alpha MCP server), but the API routes themselves do not rate-limit incoming user requests.
- **Circuit breaker.** Retry with backoff is present in `BloomreachDataSource`; a circuit breaker (open/half-open/closed state machine) is not.

## Reading order

The sub-directories are ordered as a curriculum. If you're reading straight through: 01 → 02 → 04 → 05 → 06 → 07. Skip 03 (RAG) and 08 (ML) on first pass — they're the "not exercised, in scope for shape reasons" set. 09 is interview reframes; read it after 07.

If you're pattern-matching to what a specific interview will probe: LLM application engineer roles → 04 + 05 + 06 + 07. AI infra roles → 05 + 06 + 07 (eval harness + cost controls + load + fault). Product engineer roles composing AI → 01 + 04 + 05.

## See also

- `README.md` — the file index + reading order
- `ai-features-in-this-codebase.md` — per-feature table of every AI-touching thing in the repo
- `ml-features-in-this-codebase.md` — the honest short list (there's no trained ML in the repo)
