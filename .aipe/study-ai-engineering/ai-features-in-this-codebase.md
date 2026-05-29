# AI features in this codebase

Every LLM-powered feature in blooming insights, with the patterns each uses and why. The codebase is **LLM application engineering** — all AI is Claude (via `@anthropic-ai/sdk`) orchestrating read-only Bloomreach MCP tools. There are **no machine-learning features** (no trained models, recommenders, or on-device inference), so `ml-features-in-this-codebase.md` is intentionally absent.

Common spine: all four agents share `runAgentLoop` (`lib/agents/base.ts`) — a Claude tool-use loop bounded by a `maxToolCalls` budget that forces a tool-less final turn carrying a `synthesisInstruction`. Models: agents run `claude-sonnet-4-6` (`AGENT_MODEL`, `base.ts:9`); the intent classifier runs `claude-haiku-4-5-20251001` (`intent.ts:14`). No sampling parameters are tuned (Claude defaults); only `max_tokens` is set per call.

---

### Monitoring agent — the morning briefing

- **Feature:** Scans the workspace for significant recent changes and emits the most significant anomalies as ranked insight cards (`MonitoringAgent.scan`, `lib/agents/monitoring.ts:68–103`).
- **Patterns used:** `04-agents-and-tool-use/02-tool-calling.md` (scoped `monitoringTools`, `maxToolCalls: 6`), `01-llm-foundations/04-structured-outputs.md` (`isAnomalyArray` validator), `01-llm-foundations/02-tokenization.md` + `02-context-and-prompts/01-context-window.md` (`schemaSummary` char caps: `MAX_EVENTS = 20` / `MAX_PROPS_PER_EVENT = 10` / `MAX_CPROPS = 30` at `monitoring.ts:21/22/33`), `04-agents-and-tool-use/06-error-recovery.md` (returns `[]` on parse failure; `SEV_RANK` sort + top-10 slice at `monitoring.ts:50/102`).
- **Why these patterns:** the workspace schema is large and the rate limit is tight, so the agent gets a truncated schema + a small tool budget and must return a validated array or nothing — no fabricated alerts.

### Diagnostic agent — why it happened

- **Feature:** Investigates one anomaly and produces a grounded `Diagnosis` (conclusion + evidence + hypotheses considered + optional `affectedCustomers`/`confidence`/`timeSeries`), streaming its reasoning live (`DiagnosticAgent.investigate`, `lib/agents/diagnostic.ts:45–83`).
- **Patterns used:** `04-agents-and-tool-use/03-react-pattern.md` (thought→tool→observation, streamed), `01-llm-foundations/04-structured-outputs.md` (`isDiagnosis` + a dedicated tool-less `synthesize()` at `diagnostic.ts:87–126`), `05-evals-and-observability/04-llm-observability.md` (a `confidence` is derived from how thoroughly hypotheses were tested via `diagnosisConfidence`, then downgraded if any tool call errored — `diagnostic.ts:80–82`), `04-agents-and-tool-use/06-error-recovery.md` (`FALLBACK` diagnosis at `diagnostic.ts:16–19`).
- **Why these patterns:** the model wants to keep querying; the forced synthesis turn (and the separate `synthesize()` retry on a clean context) guarantees a conclusion grounded in the evidence it already gathered, and the derived `confidence` keeps the surfaced trust signal honest about the data actually obtained.

### Recommendation agent — what to do

- **Feature:** Turns an anomaly + diagnosis into up to three concrete Bloomreach actions, each tagged with the feature it uses and an `estimatedImpact` that may be a plain string or a richer `{ range, rangeUsd?, assumption }` object (`RecommendationAgent.propose`, `lib/agents/recommendation.ts:36–77`).
- **Patterns used:** `04-agents-and-tool-use/02-tool-calling.md` (scoped `recommendationTools`), `01-llm-foundations/04-structured-outputs.md` (`isRecommendationArray` validates the id-less shape including the `EstimatedImpact` union and optional `effort`/`timeToSetUpMinutes`/`prerequisites`/`successMetric` fields; code assigns `crypto.randomUUID()` at `recommendation.ts:76`, caps at 3), `02-context-and-prompts/03-prompt-chaining.md` (runs after the diagnosis — the diagnosis is the recommendation step's input), dedicated `synthesize()` (`recommendation.ts:82–132`).
- **Why these patterns:** recommendations must be actionable and bounded; validating an id-less array then assigning ids server-side keeps the model's job small and the output trustworthy, while the optional rich fields let the UI show effort/setup-time without forcing the model to always produce them.

### Query agent — ask anything

- **Feature:** Answers a free-form natural-language question about the workspace with a tool-grounded answer (`QueryAgent.answer`, `lib/agents/query.ts:24–47`).
- **Patterns used:** `04-agents-and-tool-use/04-tool-routing.md` (the full tool set + intent routing in front), `01-llm-foundations/05-streaming.md` (NDJSON answer), `04-agents-and-tool-use/05-agent-memory.md` (one-shot — `userPrompt: query` at `query.ts:35`, no conversation memory yet), `06-production-serving/03-prompt-injection.md` (the `?q=` input is only `.trim()`'d — an open injection surface, bounded by read-only tools).
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

- **Feature:** Streams `reasoning_step` / `tool_call_start` / `tool_call_end` / `diagnosis` / `recommendation` events so the user watches the agents work, and reuses the same wire format to replay cached investigations (`AgentEvent` in `lib/mcp/events.ts`, emitted from `app/api/agent/route.ts`, consumed by `lib/hooks/useInvestigation.ts`). The trace UI renders each line with a `toLocaleTimeString` clock and tool durations (`components/shared/StatusLog.tsx` → `components/investigation/ReasoningTrace.tsx`, `ts` stamped at `useInvestigation.ts:106/113`) and pretty-prints fenced JSON / markdown content (`components/investigation/TraceContent.tsx`).
- **Patterns used:** `01-llm-foundations/05-streaming.md`, `05-evals-and-observability/04-llm-observability.md`, `04-agents-and-tool-use/03-react-pattern.md`.
- **Why these patterns:** "show its work" is both the UX and the telemetry; the same events that build the UI are the timestamped trace an engineer would inspect, and the wire format doubles as the replay format for cached snapshots.

### Two-step investigation (diagnose → recommend) with a sessionStorage handoff

- **Feature:** The drill-down is split into two pages and two separate stream calls: step 2 (`app/investigate/[id]/page.tsx`) runs ONLY the diagnostic agent (`/api/agent?step=diagnose`); step 3 (`app/investigate/[id]/recommend/page.tsx`) runs ONLY the recommendation agent (`/api/agent?step=recommend`), fed the diagnosis handed over from step 2. The split is driven by `useInvestigation(id, step)` (`lib/hooks/useInvestigation.ts`); the route reads the `step` param at `route.ts:117–118`, picks the lead agent at `route.ts:199–200`, and gates each agent (`route.ts:225–249`). The diagnose step writes the diagnosis to `sessionStorage` under `bi:diag:<id>` (`useInvestigation.ts:138–139`); the recommend step reads it back and forwards it as `&diagnosis=` (`useInvestigation.ts:72–77, 162–163`). A null `step` is the legacy combined run.
- **Patterns used:** `04-agents-and-tool-use/01-agents-vs-chains.md` (each step is one agent, not the whole pipeline), `02-context-and-prompts/03-prompt-chaining.md` (the diagnosis is the literal input to the recommendation step), `01-llm-foundations/05-streaming.md` (each step is its own NDJSON stream consumed by the hook).
- **Why these patterns:** splitting the chain across two user-driven steps means the expensive recommendation run is deferred until the user actually asks for it, and the sessionStorage handoff carries the prior step's output across the page navigation without re-running the diagnostic agent.

### Demo vs. live mode + the dev one-click demo-snapshot capture

- **Feature:** The feed runs in two runtime modes toggled in the UI and persisted in `localStorage` (`app/page.tsx:108–131`): **demo** replays a committed snapshot (`/api/briefing?demo=cached` → `lib/state/demo-insights.json`, served at `briefing/route.ts:42–50`), **live** runs the agents against the real workspace. A dev-only "capture this as the demo snapshot (one click)" button (`app/page.tsx:196–246`, gated to `NODE_ENV !== 'production'` and live mode) POSTs the current live briefing to `/api/mcp/capture-demo` (writes `demo-insights.json` + bundles already-run investigations into `demo-investigations.json`); the route itself is hard-disabled in production (`capture-demo/route.ts:11–14`).
- **Patterns used:** `05-evals-and-observability/04-llm-observability.md` (a captured snapshot is a frozen, replayable trace — a de-facto golden record of one real run), `06-production-serving/01-llm-caching.md` (demo mode is a whole-response cache that needs no API key and is instant).
- **Why these patterns:** a live multi-agent run costs ~100s and an API key; baking one real run into a committed snapshot makes the demo instant and reliable for a presentation while keeping the capture path dev-only because serverless filesystems are read-only.

### Enrichment derivation (agent-written impact + derived confidence)

- **Feature:** Two enrichments make agent output business-readable without asking the model to fabricate. (1) The monitoring agent writes a one-sentence business `impact` per anomaly, carried straight through `anomalyToInsight` (`lib/state/insights.ts:23`); alongside it, `deriveInsightFields` (`lib/insights/derive.ts:27–39`) computes a `revenueImpact` purely from the evidence the agent already gathered (no new data). (2) The diagnostic agent's `confidence` is **derived** by `diagnosisConfidence` (`lib/insights/derive.ts:54–63`) from how thoroughly hypotheses were tested and whether one was supported — preferring the agent's own `confidence` when set, and downgraded high→medium when any tool call errored (`diagnostic.ts:80–82`).
- **Patterns used:** `01-llm-foundations/04-structured-outputs.md` (the agent emits a typed `impact`; the derived fields are optional + computed, so older snapshots still validate), `05-evals-and-observability/04-llm-observability.md` (a confidence derived from observed hypothesis-testing is an honest trust signal, not a self-reported one).
- **Why these patterns:** asking the model for a self-reported confidence invites optimism; deriving it from what was actually tested — and downgrading it when queries failed — keeps the surfaced signal grounded in the run's real evidence, while keeping the derived fields optional preserves backward compatibility.

---

**Retrieval note:** the codebase's "retrieval" is live MCP tool calls + EQL against Bloomreach, deliberately **not** embedding-RAG — see `03-retrieval-and-rag/11-rag.md` for the design rationale and the threshold at which RAG would earn its place.

---
Updated: 2026-05-28 — refreshed all stale file/line refs (monitoring/diagnostic/recommendation/query agents, dropped the removed `summarizeTrace`), and added four feature entries: the two-step diagnose→recommend split with the `bi:diag:<id>` sessionStorage handoff, demo-vs-live mode + the dev one-click capture, enrichment derivation (agent `impact` + derived `confidence`), and the richer structured-output fields / timestamped streaming-trace render.
