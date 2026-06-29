# Audit — AI engineering lenses against this codebase

Seven lenses walked against the codebase as it stands. Each lens names what's actually there (with `file:line` evidence) or `not yet exercised` honestly. Sub-section folders take the deep walk; this file is the inventory.

The codebase shape is **LLM application engineering**. No classical ML, no embeddings, no trained models. The audit is honest about that — three lenses (vector retrieval, supervised pipelines, on-device inference) come back `not yet exercised`.

---

## 1. LLM call surface — how a prompt actually reaches the model

**What's there.**

  → Five agents wrap `@aptkit/core@0.3.0`: monitoring (`lib/agents/monitoring.ts`), diagnostic (`lib/agents/diagnostic.ts`), recommendation (`lib/agents/recommendation.ts`), query (`lib/agents/query.ts`), intent (`lib/agents/intent.ts`). Each is a thin constructor (34–116 LOC) that instantiates the AptKit agent.
  → The `complete()` call to `claude-sonnet-4-6` lives in one place: `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:42`. Every agent's LLM call funnels through that single method.
  → The intent classifier is the only cheap-model use: `claude-haiku-4-5-20251001` at `lib/agents/intent.ts:16`. Everything else runs on Sonnet.
  → Sampling is implicit — no temperature, top-p, or top-k set at the call site. AptKit may set defaults; this codebase relies on those defaults.
  → Structured outputs are enforced through tool-calling, not a JSON schema. The model is given an MCP tool schema and asked to call it; the response shape is constrained by the tool definition. See `lib/agents/tool-schemas.ts:17` (`filterToolSchemas`) and `lib/agents/aptkit-adapters.ts:78` (`toAnthropicTool`).
  → No streaming. The adapter uses `messages.create()` (non-streaming) — `MessageCreateParamsNonStreaming` at `lib/agents/aptkit-adapters.ts:42`. Streaming happens at the NDJSON layer between the route and the browser, NOT at the LLM call.

**The deep walk:** `01-llm-foundations/`.

---

## 2. Context discipline — what goes into the window, what doesn't

**What's there.**

  → The system prompt for each agent is templated from `lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation,query}.md` (still consumed by the legacy-prompt path; production agents now use AptKit's built-in prompts). Each prompt is a single markdown file under 200 lines.
  → Schema is summarized before going into the prompt: `schemaSummary(schema)` at `lib/agents/monitoring.ts:18` caps event count at 20 and properties per event at 10. The full 112KB workspace schema is never sent to the model.
  → No conversation history. Every investigation is a fresh agent turn; there's no multi-session memory. The handoff from diagnose → recommend (`02-context-and-prompts/03-prompt-chaining.md`) is the only inter-turn state, and it's a structured object passed in as input, not appended history.
  → Token economics are logged but not budgeted: `console.log(JSON.stringify({ site, sessionId, usage: response.usage }))` at `lib/agents/aptkit-adapters.ts:55-60`. No token cap, no per-route budget, no alert when usage spikes.

**The deep walk:** `02-context-and-prompts/`.

---

## 3. Retrieval and RAG — finding the right thing to put in the prompt

**What's NOT there.**

  → No embeddings. No vector store. No `pgvector`, `sqlite-vec`, Pinecone, Chroma, Qdrant. The dependency graph is `@anthropic-ai/sdk`, `@aptkit/core`, `@modelcontextprotocol/sdk` — nothing for embedding or ANN search.
  → No chunking. The corpus this app reasons over is the Bloomreach workspace schema (events, customer properties, catalogs), which is fetched whole and summarized, not chunked.
  → No reranking, no hybrid search, no query rewriting, no HyDE.

**What's there (the retrieval pattern that DOES exist).**

  → **Schema-as-retrieval.** `bootstrapSchema()` at `lib/mcp/schema.ts:174` walks the Bloomreach orchestrator (`list_cloud_organizations` → `list_projects` → `get_event_schema` → `get_customer_property_schema` → `list_catalogs` → `get_project_overview`) once per session and caches the result. The agents read from this shape, not from a vector DB. → see `03-retrieval-and-rag/01-schema-as-retrieval.md`.
  → **Schema-gated coverage.** Before the monitoring agent runs, `schemaCapabilities(schema)` + `coverageReport()` + `runnableCategories()` at `lib/agents/categories.ts:24-46` filter the 10-category checklist to only the categories the workspace can actually support. The agent is never given a tool it can't use against this workspace. → see `03-retrieval-and-rag/02-schema-gated-coverage.md`.

**The deep walk:** `03-retrieval-and-rag/`.

---

## 4. Agent loop and tool use

**What's there.**

  → Five agents, one loop. The ReAct loop lives in `@aptkit/core@0.3.0`, NOT in this repo. Blooming's agents (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) are 34–116 LOC each — pure wrappers that construct AptKit's reusable agents.
  → The bridge is 206 lines: `lib/agents/aptkit-adapters.ts`. Three adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) implement AptKit's ports (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`).
  → Tool calling is via Anthropic's tool-use API: `toAnthropicTool()` at `lib/agents/aptkit-adapters.ts:78`, input schemas pulled from the live MCP server's `listTools()`. The model receives the MCP tool schema, decides which tool to call, the adapter executes it through the `DataSource` port.
  → Tool routing is heuristic-by-allowlist: each agent receives a different `McpToolDef[]` subset built at `lib/mcp/tools.ts`. Monitoring gets 13 tools, diagnostic gets 17, recommendation gets 7, query gets the union. The model can only pick from its agent's subset.
  → Intent classification (`lib/agents/intent.ts`) is itself an LLM call — Haiku decides whether a free-form question is `monitoring`, `diagnostic`, `recommendation`, or `generic`, which then selects the right downstream agent. Heuristic-before-LLM pattern at the *intent* level, not the *tool* level.
  → Error recovery is delegated to AptKit (the loop). Blooming surfaces errors via `BloomingTraceSinkAdapter.emit()` at `lib/agents/aptkit-adapters.ts:108-128` — tool failures become `tool_call_end` events with an `error` field; the model sees the error and can retry.

**The deep walk:** `04-agents-and-tool-use/`.

---

## 5. Evals and observability

**What's there (observability).**

  → Per-call usage logged from inside the model adapter: `lib/agents/aptkit-adapters.ts:55-60` emits a JSON line with `{ site, sessionId, usage }` on every Anthropic call. Both monitoring and intent agents log to the same key, so a Vercel log filter on `site = "agents/monitoring:aptkit-model"` gives per-agent token volume.
  → Per-phase wall-clock timings logged from inside the route: `app/api/briefing/route.ts:307-316` and `app/api/agent/route.ts:331-340` push `{ phase, durationMs }` into a `phases[]` array and emit one summary line per request (even on error, via `finally`). Shape is shared so a single Vercel filter reads both routes.
  → Tool-call traces are first-class: the `AgentEvent` NDJSON contract (`lib/mcp/events.ts`) carries `tool_call_start` and `tool_call_end` events that the UI renders inline as `ToolCallBlock`s.

**What's there (evals — retired-historical).**

  → A Phase 3 4-pillar eval suite (detection / diagnosis / recommendation / regression) was built on an Olist data substrate, with Sonnet 4.6 as both agent and judge, K=10 per anomaly × 3 seeded anomalies, LLM-as-judge calibrated by 8/8 + 3/3 manual spot-check. It surfaced three real bugs: BRL cents-vs-Reais (run 8, R$131,965 implausible AOV), binary calibration (29/30), conclusion instability (30%). The suite was **retired in PR #8 (2026-06-18)** along with the Olist substrate. The next eval iteration targets the `SyntheticDataSource` adapter, not Olist.

**What's NOT there.**

  → No eval set in the active codebase today. The `test/` directory carries 24 files / 221 passing unit + integration tests, but no LLM eval set, no golden answers, no LLM-as-judge.
  → No observability vendor (Langfuse, LangSmith, Phoenix, Helicone). The telemetry is Vercel log lines.

**The deep walk:** `05-evals-and-observability/`.

---

## 6. Production serving — keeping the LLM call surface alive in front of users

**What's there.**

  → 60s response cache lives inside `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:140-150`). Keyed on `${name}:${JSON.stringify(args)}`. Caches successful tool results; never caches errors. Optional per-call `skipCache` for the `/debug` path.
  → Proactive rate spacing: `~1.1s` between MCP calls (`minIntervalMs: 1100` at `lib/mcp/connect.ts:105`) because Bloomreach rate-limits globally per user.
  → Rate-limit retry with parsed-window honoring: `BloomreachDataSource.callTool()` at `lib/data-source/bloomreach-data-source.ts:153-170` parses the server's stated `"per X second"` window from the 429 error text, waits that long + a 500ms buffer, retries up to 3 times. Falls back to exponential backoff if no hint is parseable.
  → Cancellation threaded everywhere: `req.signal` flows through every layer — route → agent → AptKit → `DataSource.callTool()` → `anthropic.messages.create()`. A client navigating away cancels the in-flight LLM and MCP calls.
  → Anthropic prompt caching: NOT explicitly enabled. The adapter does not set `cache_control` on the system prompt. Long agent prompts pay full price on every call.
  → Cheap-classifier routing: the intent classifier uses Haiku before any Sonnet agent runs (`lib/agents/intent.ts:16`). One call to a cheap model saves a full Sonnet agent run when the user's question is generic.
  → Circuit breaker: not implemented. Rate-limit retry hands back to the caller after 3 attempts; the next request retries from scratch.
  → Prompt injection: surface exists (the user's free-form question feeds the `query` agent's prompt). Defense is structural — the agent can only call MCP tools (not arbitrary actions), and the structured-output path is constrained by tool schemas. No explicit user-input sanitization.

**The deep walk:** `06-production-serving/`.

---

## 7. System-design templates — the codebase reframed as interview prompts

**What's there.**

The codebase exemplifies two of the IK interview templates (`partially` and `partially` respectively):

  → **Search ranking** (`07-system-design-templates/01-search-ranking.md`). `Partially` — the schema-gating + retrieval pattern is the *candidate-narrowing* layer of a search ranking system, but there's no learned ranker, no click logs, no cross-encoder rerank. The "how to make it apply" path is to add a ranking surface for the insights feed.
  → **Tech support chatbot** (`07-system-design-templates/02-tech-support-chatbot.md`). `Partially` — the multi-agent diagnostic flow (intent → diagnose → recommend) is structurally a chatbot's intent-classify → RAG-retrieve → constrained-response pattern, but the corpus is workspace metrics (not docs), and there's no escalation path or feedback loop.

The ML-side templates (recommender, anomaly detection, object detection) are skipped — this codebase is pure LLM application engineering.

  → **Anomaly detection — special case.** Bloomreach's monitoring agent is *itself* an anomaly detection system at the business-metric layer (the 10-category checklist, threshold gating, severity scoring). But it's an LLM-driven anomaly detector, not the trained-model anomaly detector the ML template asks about. Worth naming in interviews, not worth a dedicated template file.

**The deep walk:** `07-system-design-templates/`.

---

## Top finding

The codebase is unusually disciplined about **boundaries** for an LLM app — three ports (`ModelProvider`, `ToolRegistry`, `DataSource`) carry the entire pivot surface in 206 lines of adapter glue (`lib/agents/aptkit-adapters.ts`). Two adapter swaps have already happened without changing agent code (Olist → retired; Synthetic added). The weak point is the **eval side**: with the Phase 3 suite retired, there is no live regression coverage of agent behavior against any substrate today. The next move is the rebuilt eval suite against `SyntheticDataSource` — same loop, new substrate.
