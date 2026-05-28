# AI features in this codebase

Every LLM-powered feature in blooming insights, with the patterns each uses and why. The codebase is **LLM application engineering** — all AI is Claude (via `@anthropic-ai/sdk`) orchestrating read-only Bloomreach MCP tools. There are **no machine-learning features** (no trained models, recommenders, or on-device inference), so `ml-features-in-this-codebase.md` is intentionally absent.

Common spine: all four agents share `runAgentLoop` (`lib/agents/base.ts`) — a Claude tool-use loop bounded by a `maxToolCalls` budget that forces a tool-less final turn carrying a `synthesisInstruction`. Models: agents run `claude-sonnet-4-6` (`AGENT_MODEL`, `base.ts:9`); the intent classifier runs `claude-haiku-4-5-20251001` (`intent.ts:14`). No sampling parameters are tuned (Claude defaults); only `max_tokens` is set per call.

---

### Monitoring agent — the morning briefing

- **Feature:** Scans the workspace over a 90-day vs prior-90-day window and emits the most significant anomalies as ranked insight cards (`MonitoringAgent.scan`, `lib/agents/monitoring.ts:60–93`).
- **Patterns used:** `04-agents-and-tool-use/02-tool-calling.md` (scoped `monitoringTools`), `01-llm-foundations/04-structured-outputs.md` (`isAnomalyArray` validator), `01-llm-foundations/02-tokenization.md` + `02-context-and-prompts/01-context-window.md` (`schemaSummary` char caps: 20 events / 10 props / 30 customer-props), `04-agents-and-tool-use/06-error-recovery.md` (returns `[]` on parse failure; `SEV_RANK` sort + top-10 slice at `monitoring.ts:50/92`).
- **Why these patterns:** the workspace schema is large and the rate limit is tight, so the agent gets a truncated schema + a small tool budget and must return a validated array or nothing — no fabricated alerts.

### Diagnostic agent — why it happened

- **Feature:** Investigates one anomaly and produces a grounded `Diagnosis` (conclusion + evidence + hypotheses considered), streaming its reasoning live (`DiagnosticAgent.investigate`, `lib/agents/diagnostic.ts:44–78`).
- **Patterns used:** `04-agents-and-tool-use/03-react-pattern.md` (thought→tool→observation, streamed), `01-llm-foundations/04-structured-outputs.md` (`isDiagnosis` + a dedicated tool-less `synthesize()` at `diagnostic.ts:82–121`), `04-agents-and-tool-use/06-error-recovery.md` (`FALLBACK` diagnosis at `diagnostic.ts:15–19`), `05-evals-and-observability/04-llm-observability.md` (the trace is the surface).
- **Why these patterns:** the model wants to keep querying; the forced synthesis turn (and the separate `synthesize()` retry on a clean context) guarantees a conclusion grounded in the evidence it already gathered.

### Recommendation agent — what to do

- **Feature:** Turns an anomaly + diagnosis into up to three concrete Bloomreach actions, each tagged with the feature it uses (`RecommendationAgent.propose`, `lib/agents/recommendation.ts:36–77`).
- **Patterns used:** `04-agents-and-tool-use/02-tool-calling.md` (scoped `recommendationTools`), `01-llm-foundations/04-structured-outputs.md` (`isRecommendationArray` validates the id-less shape; code assigns `crypto.randomUUID()` at `recommendation.ts:76`, caps at 3), `02-context-and-prompts/03-prompt-chaining.md` (runs after the diagnosis in the briefing chain), dedicated `synthesize()` (`recommendation.ts:82–127`).
- **Why these patterns:** recommendations must be actionable and bounded; validating an id-less array then assigning ids server-side keeps the model's job small and the output trustworthy.

### Query agent — ask anything

- **Feature:** Answers a free-form natural-language question about the workspace with a tool-grounded answer (`QueryAgent.answer`, `lib/agents/query.ts:23–48`).
- **Patterns used:** `04-agents-and-tool-use/04-tool-routing.md` (the union `queryTools` + intent routing in front), `01-llm-foundations/05-streaming.md` (NDJSON answer), `04-agents-and-tool-use/05-agent-memory.md` (one-shot — no conversation memory yet), `06-production-serving/03-prompt-injection.md` (the `?q=` input is only `.trim()`'d — an open injection surface, bounded by read-only tools).
- **Why these patterns:** reuse the same loop with the broadest tool set; the open input is the one place an adversary can reach the model, so it is flagged as the priority hardening target.

### Intent classifier — routing the question

- **Feature:** Decides which agent path a `?q=` question takes (`parseIntent` heuristic at `intent.ts:6–12`, then `classifyIntent` haiku at `intent.ts:17–31`).
- **Patterns used:** `01-llm-foundations/07-heuristic-before-llm.md` (cheap deterministic check first), `01-llm-foundations/06-token-economics.md` (haiku + `max_tokens: 16` forces a one-word answer), `04-agents-and-tool-use/04-tool-routing.md`.
- **Why these patterns:** classification is high-volume and cheap-to-get-right; a heuristic resolves the obvious cases for free and only ambiguous ones pay for the (already cheap) model.

### Structured-output extraction + validation

- **Feature:** Converts every agent's prose into a typed contract or rejects it (`parseAgentJson` + type guards, `lib/mcp/validate.ts:3–53`).
- **Patterns used:** `01-llm-foundations/04-structured-outputs.md`, `01-llm-foundations/01-what-an-llm-is.md` (treat output as untrusted), `04-agents-and-tool-use/06-error-recovery.md`.
- **Why these patterns:** the model is a next-token function; a parse-then-validate boundary is the same discipline as validating an API response before trusting it.

### Streaming reasoning trace (observability-as-product)

- **Feature:** Streams `reasoning_step` / `tool_call_start` / `tool_call_end` events so the user watches the agents work, and reuses the wire format to replay cached investigations (`lib/mcp/events.ts`, `app/api/agent/route.ts`, `app/investigate/[id]/page.tsx`; `summarizeTrace` in `app/api/briefing/route.ts:13–21`).
- **Patterns used:** `01-llm-foundations/05-streaming.md`, `05-evals-and-observability/04-llm-observability.md`, `04-agents-and-tool-use/03-react-pattern.md`.
- **Why these patterns:** "show its work" is both the UX and the telemetry; the same events that build the UI are the trace an engineer would inspect.

---

**Retrieval note:** the codebase's "retrieval" is live MCP tool calls + EQL against Bloomreach, deliberately **not** embedding-RAG — see `03-retrieval-and-rag/11-rag.md` for the design rationale and the threshold at which RAG would earn its place.
