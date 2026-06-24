# Agent patterns in this codebase

Every agent loop in blooming insights, the pattern it instantiates, and the control envelope around it. The codebase is a **multi-agent system** in the **minimal multi-agent topology** — a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router for free-form questions, with the typed `Diagnosis` as the inter-stage message between the diagnostic and recommendation stages. Orchestration is **deterministic route code**, not an LLM supervisor — a deliberate "don't pay the coordination tax until you need it" choice.

**The shared spine has changed providers.** The four agent classes in `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` are now **thin wrappers over `@aptkit/core`** (Blooming-owned bridge: `lib/agents/aptkit-adapters.ts`, 206 LOC). Each wrapper still exposes Blooming's constructor + method shape (`MonitoringAgent.scan`, `DiagnosticAgent.investigate`, `RecommendationAgent.propose`, `QueryAgent.answer`); inside, the active runtime is AptKit's — `AnomalyMonitoringAgent` / `DiagnosticInvestigationAgent` / `RecommendationAgent` / `QueryAgent` from `@aptkit/core`. Blooming's own `runAgentLoop` is preserved at `lib/agents/base-legacy.ts:86–222` as the LEGACY spine; sibling `*-legacy.ts` files keep the legacy path intact (`monitoring-legacy.ts`, `diagnostic-legacy.ts`, `recommendation-legacy.ts`, `query-legacy.ts`, `intent-legacy.ts`, `categories-legacy.ts`). The active code path never calls them.

**Adapter-switchable data plane.** Phase 2's `DataSource` interface (`lib/data-source/types.ts`) survives — every agent class still holds a `DataSource`. Two adapters live behind it today: `BloomreachDataSource` (live OAuth MCP, `lib/data-source/bloomreach-data-source.ts`) and `SyntheticDataSource` (`lib/data-source/synthetic-data-source.ts`, 516 LOC, in-process deterministic fakes — replaces the old Olist subprocess adapter). The `bi:mode` localStorage key holds `'demo' | 'live-bloomreach' | 'live-synthetic'`; the factory at `lib/data-source/index.ts`'s `makeDataSource(mode, sid)` (`parseLiveMode` at L52) hands the route the right adapter. The factory's `LiveMode` is `'live-bloomreach' | 'live-synthetic'` now; the Olist branch is gone with its sibling package.

---

## The shared spine — read this first

**The active spine is AptKit-owned, not Blooming-owned.** Every active agent class in this codebase constructs an `@aptkit/core` agent inside its method body, hands it three Blooming-owned adapter objects, and returns the result mapped back into Blooming's domain types. That's the whole shape. The three adapters live in `lib/agents/aptkit-adapters.ts`:

- `AnthropicModelProviderAdapter` (L26–L72) — implements AptKit's `ModelProvider` over the existing `@anthropic-ai/sdk` client. Maps AptKit's `ModelRequest`/`ModelResponse` shapes to/from `Anthropic.Messages.MessageCreateParamsNonStreaming` and the SDK's reply blocks. Logs `usage` per turn under `agents/<name>:aptkit-model`.
- `BloomingToolRegistryAdapter` (L75–L97) — implements AptKit's `ToolRegistry` over Blooming's `McpCaller` (= `Pick<DataSource, 'callTool'>`) seam from `lib/agents/base.ts:14`. `listTools()` returns the pre-fetched `McpToolDef[]`; `callTool()` forwards to `dataSource.callTool(...)`.
- `BloomingTraceSinkAdapter` (L100–L142) — implements AptKit's `CapabilityTraceSink` and translates AptKit's `CapabilityEvent` ({step | tool_call_start | tool_call_end}) into Blooming's existing `ToolCall` shape + `onToolCall`/`onToolResult`/`onText` hooks the route layer already wires into NDJSON.

The AptKit agent classes own the loop body now — the ReAct turn-by-turn decisions, the budget cap, the forced-final synthesis, the tool dispatch through the registry, the trace event emission. Blooming's `runAgentLoop` does NOT run on the active path. It still exists in `base-legacy.ts:86` (intact) plus the per-agent `*-legacy.ts` callers, in case the migration needs to revert; the test suite covers the legacy path on the legacy classes only.

The four agent classes are tiny:
- `MonitoringAgent.scan` (`lib/agents/monitoring.ts:82–93`) — constructs `AptKitAnomalyMonitoringAgent` with the three adapters + workspace + the runnable categories list, calls `.scan({ signal })`, maps each `MonitoringAnomaly` back to Blooming's `Anomaly` shape.
- `DiagnosticAgent.investigate` (`lib/agents/diagnostic.ts:35–44`) — constructs `AptKitDiagnosticInvestigationAgent` with the three adapters, calls `.investigate(anomaly, { signal })`, the diagnosis type is shape-compatible with Blooming's `Diagnosis`.
- `RecommendationAgent.propose` (`lib/agents/recommendation.ts:26–39`) — constructs `AptKitRecommendationAgent`, calls `.propose(anomaly, diagnosis, { signal })`, returns the array.
- `QueryAgent.answer` (`lib/agents/query.ts:24–33`) — constructs `AptKitQueryAgent`, calls `.answer(query, { intent, signal })`, returns the final text.

Model: `claude-sonnet-4-6` (`AGENT_MODEL`, `lib/agents/base.ts:7`) for all four agents; `claude-haiku-4-5-20251001` for the intent classifier (`lib/agents/intent.ts:16`). Both the Anthropic client and the data source are still injected — the 221 vitest tests under `test/` use fakes that satisfy `DataSource` and the Anthropic SDK shape, so no network is required to drive the structural contracts.

**The ecommerce category registry has also moved.** AptKit owns the canonical category list (`MonitoringAnomalyCategory` from `@aptkit/core`); Blooming converts its Blooming-side `AnomalyCategory[]` to the AptKit shape via `toAptKitCategories` at `lib/agents/monitoring.ts:96–109`. The legacy 10-category checklist + `coverageReport` machinery is preserved at `lib/agents/categories-legacy.ts` for the legacy path.

The bridge to SECTION C's multi-agent topology: this migration changed *whose* runtime drives each ReAct loop, not how many ReAct loops sit in the pipeline. The topology (monitoring → diagnostic → recommendation) is unchanged. What did change: a senior AI-engineering move landed — "own your domain (the wrappers, the bridge adapters, the data plane); defer reusable agent behavior to a library." See `04-agent-infrastructure/06-aptkit-runtime-layer.md` for that pattern as a concept.

Because the loop only knows the `DataSource` seam, the model never sees raw HTTP — under Bloomreach it sees the workspace's MCP tool surface (~27 tools); under Synthetic it sees the in-process tool surface defined by `lib/mcp/tools.ts` (Bloomreach-shaped, per-agent allowlists), backed by deterministic fake data.

---

## Agents in this codebase

### Monitoring agent — the morning briefing

- **Feature:** Scans the workspace for significant recent changes and emits the top anomalies as ranked insight cards (`MonitoringAgent.scan`, `lib/agents/monitoring.ts:82–93`). Takes a category checklist (`scan(hooks, categories)`) — converted to `MonitoringAnomalyCategory[]` and handed to AptKit's `AnomalyMonitoringAgent` so the prompt only asks about categories the schema can support.
- **Pattern / shape:** ReAct (AptKit-owned spine) + **capability gating** in front. The active spine is `@aptkit/core`'s `AnomalyMonitoringAgent.scan`; Blooming's job here is to give it three adapter objects, a workspace schema, and the category list — then map `MonitoringAnomaly[]` back to Blooming's `Anomaly` via `toBloomingAnomaly` at `monitoring.ts:111–116`.
- **Why this pattern:** the workspace schema is large and the Bloomreach rate limit is ~1 req/s; the cheapest way to keep the loop honest is to scope its *checklist* before it spends any budget — the agent literally cannot fabricate alerts on categories that aren't on its list, because the AptKit agent's prompt is generated from the list it was constructed with.
- **Control envelope:** budget + forced-final synthesis are owned by AptKit's `AnomalyMonitoringAgent` (not configured at the Blooming call site). The pre-spend gate (`runnableCategories`) is Blooming's, applied before the AptKit agent is constructed. Cancellation: `hooks.signal` threads through `agent.scan({ signal })`.
- **Eval:** the streamed `AgentEvent` trace (`lib/mcp/events.ts`) is the inspectable trajectory — every `reasoning_step`, `tool_call_start`, `tool_call_end` and the final anomaly array. The 221 unit tests under `test/` verify the loop's structural contracts with injected fakes. There is no automated trajectory-eval harness in the repo today; that pipeline was removed when the `eval/` directory and the `mcp-server-olist/` sibling package were removed.

### Diagnostic agent — why it happened

- **Feature:** Investigates one anomaly and produces a grounded `Diagnosis` — conclusion + evidence + `hypothesesConsidered` + optional `affectedCustomers` / `confidence` / `timeSeries` (`DiagnosticAgent.investigate`, `lib/agents/diagnostic.ts:35–44`).
- **Pattern / shape:** ReAct (AptKit-owned spine) + **structured chain-of-thought**. AptKit's `DiagnosticInvestigationAgent` owns the loop; Blooming's wrapper hands it the adapters + workspace, then forwards the typed result. The `hypothesesConsidered` field is the chain-of-thought escaping the conversation into the output schema, so it's inspectable rather than buried in the model's reasoning trace.
- **Why this pattern:** the diagnostic agent's job is *justified* conclusion — the evidence and the rejected hypotheses are part of the contract, not just the conclusion. Tool-less recovery on parse failure now lives inside AptKit; the legacy Blooming-side recovery (`diagnostic-legacy.ts:87–126`) is preserved but inactive.
- **Control envelope:** budget + forced-final + recovery all owned by AptKit. Cancellation: `hooks.signal` threads through `agent.investigate(anomaly, { signal })`. `confidence` derivation lives in `lib/insights/derive.ts` and runs on the returned diagnosis, regardless of which runtime produced it.
- **Eval:** streamed `AgentEvent` trajectory + derived `confidence`. No automated trajectory eval today.

### Recommendation agent — what to do

- **Feature:** Turns an anomaly + diagnosis into up to three concrete Bloomreach actions, each tagged with feature, `estimatedImpact`, and optional `effort` / `timeToSetUpMinutes` / `prerequisites` / `successMetric` (`RecommendationAgent.propose`, `lib/agents/recommendation.ts:26–39`).
- **Pattern / shape:** ReAct (AptKit-owned spine) + **id-less output** (server assigns ids inside AptKit). Caps at 3.
- **Why this pattern:** recommendations are **suggestions** for the human to enact inside Bloomreach UI (a scenario, an email send, a segment) — they are **not** actions the agent takes. Read-only MCP tools mean no side effect is structurally possible regardless of what the model emits.
- **Control envelope:** budget + forced-final + recovery owned by AptKit. Cancellation: `hooks.signal` threads through `agent.propose(anomaly, diagnosis, { signal })`.
- **Eval:** streamed `AgentEvent`. No automated trajectory eval today.

### Query agent — ask anything

- **Feature:** Answers a free-form natural-language question about the workspace with a tool-grounded prose answer (`QueryAgent.answer`, `lib/agents/query.ts:24–33`).
- **Pattern / shape:** ReAct (AptKit-owned spine) + **prose output** (no schema validator — the answer is for the user to read). One-shot per question; no conversation memory between calls.
- **Why this pattern:** the broadest tool set is needed because the question can be about anything; intent routing in front (`parseIntent` → `classifyIntent`) classifies what *kind* of question it is, and the AptKit `QueryAgent.answer` takes the intent as an option so its internal prompt can guide exploration.
- **Control envelope:** budget + forced-final owned by AptKit. The `?q=` input is `.trim()`'d at the route layer (an open prompt-injection surface, bounded by the read-only tool surface — see SECTION D's guardrails file). Cancellation: `hooks.signal` threads through `agent.answer(query, { intent, signal })`.
- **Eval:** streamed `AgentEvent`; the final text is the answer.

### Intent classifier — routing the question

- **Feature:** Decides which agent path a `?q=` question takes (`parseIntent` re-exports AptKit's `parseIntent`; `classifyIntent` at `lib/agents/intent.ts:21–38` re-exports AptKit's `classifyIntent` after wrapping the Anthropic client in `AnthropicModelProviderAdapter`).
- **Pattern / shape:** **Routing** — heuristic-first + LLM classifier on miss. Not an agent loop; one model call. Cross-references SECTION A's `06-routing.md`.
- **Why this pattern:** classification is high-volume and cheap-to-get-right; the heuristic resolves the obvious cases for free, and only ambiguous ones pay for the (already cheap) haiku model.
- **Control envelope:** classifier is one model call with the haiku model. Cancellation: `signal` threads through `classifyAptKitIntent(adapter, query, { signal })`.
- **Eval:** none separately — the downstream agent's output is the integration test.

### Coverage gate (anomaly-coverage schema gate) — scope before spend

- **Feature:** Before the monitoring agent runs, a cheap in-memory gate classifies a fixed 10-category anomaly checklist against the live workspace schema and hands the agent only the runnable categories. The active wiring uses `@aptkit/core`'s ecommerce category registry via the Blooming-side `categories.ts` adapter (`lib/agents/categories.ts`); the legacy hand-rolled coverage report machinery is preserved at `categories-legacy.ts`.
- **Pattern / shape:** **Capability gating** — schema-driven feature detection, pre-loop. Not an agent; a deterministic classifier over the workspace schema returning a runnable category list.
- **Why this pattern:** the agent's scarce resource is its bounded budget. A free schema check up front means every spent call is on a category that can produce a result — the "scope before spend" rule.
- **Control envelope:** pure function over the schema, no LLM, no budget.
- **Eval:** snapshot tests against representative schemas. No trajectory eval — there is no trajectory.

---

## Orchestration

### Deterministic sequential pipeline + message passing — not an LLM supervisor

- **Feature:** The investigation flow runs as `monitoring → diagnostic → recommendation`, each stage user-gated. Step 2 (`app/investigate/[id]/page.tsx`) runs ONLY the diagnostic agent (`/api/agent?step=diagnose`); step 3 (`app/investigate/[id]/recommend/page.tsx`) runs ONLY the recommendation agent (`/api/agent?step=recommend`), fed the diagnosis handed over from step 2. The route reads the `step` param, picks the lead agent, and gates each agent. The diagnose step writes its diagnosis to `sessionStorage` under `bi:diag:<id>` (`lib/hooks/useInvestigation.ts`); the recommend step reads it back and forwards it as `&diagnosis=`. A null `step` is the legacy combined run (used by the demo-snapshot capture path).
- **Pattern / shape:** **Sequential pipeline** (SECTION C's `03-sequential-pipeline.md`) + **message passing** (SECTION C's `08-shared-state-and-message-passing.md`) where the message is a typed `Diagnosis`. The pipeline stages are now AptKit-backed wrappers; the pipeline itself is unchanged. Demo replay filters a cached combined-run trace down to one step's events via `filterByStep`.
- **Why this pattern, not a supervisor:** the steps are knowable in advance (anomaly → diagnosis → recommendation is the product, not a dynamic plan), the user decides when each step runs (deferred-cost UX), and one source + one rate limit makes fan-out unprofitable. An LLM supervisor would add 2–5x coordination overhead, a larger debugging surface, and the conflict-merge failure mode, in exchange for zero benefit.
- **Control envelope:** Vercel `maxDuration = 300` caps the whole route at 5 minutes. Each AptKit agent's own budget bounds its turn count; the typed `Diagnosis` schema gates the inter-stage handoff (`parseDiagnosis` at `app/api/agent/route.ts`); `BloomreachDataSource` enforces 60s TTL cache, ~1.1s spacing, bounded exponential-backoff retry, no-cache-on-error. `SyntheticDataSource` has no rate limit (it's in-process) — same `DataSource` contract, different per-call cost.
- **Eval:** the streamed `AgentEvent` trace is the inspectable trajectory — both online (the user watches the agents work) and as a frozen replay artifact (`saveInvestigation` writes NDJSON; demo mode replays via `filterByStep`). No automated trajectory-eval harness lives in the repo today.

---

## Closing note

Blooming insights deliberately stayed at the **minimal multi-agent topology** — four ReAct agents on one shared spine, one schema-driven capability gate, one intent router, and a deterministic sequential pipeline. The orchestration is route code, the inter-stage message is a typed value passed through `sessionStorage`, and the only "supervisor" is the URL `step` param.

The topology has held through two migrations. **Phase 2** swapped a `DataSource` seam underneath the agents — the seam survives today with Bloomreach and Synthetic adapters on either side of it. **The AptKit migration** (v0.3.0, landed in PR #8 commit 62c24d7 and follow-ups) moved the active ReAct runtime out of Blooming's `runAgentLoop` and into `@aptkit/core`, with three Blooming-owned adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter` in `lib/agents/aptkit-adapters.ts`) bridging the two. The legacy Blooming spine is preserved as `*-legacy.ts` siblings for revertibility. The same migration removed the eval/ pipeline and the sibling `mcp-server-olist/` package — the in-repo measurement story is back to "structural unit tests + the streamed `AgentEvent` trajectory as the inspectable artifact"; the trajectory-eval harness with portfolio numbers is gone with the directory it lived in.

The next escalations — supervisor-worker with an *LLM* supervisor, parallel fan-out across data domains, graph orchestration with checkpointed state and human-in-the-loop pauses — are mapped as concrete refactors in `06-orchestration-system-design-templates/`. The "how to make it apply" bullets in those templates name the files in this repo each refactor would touch. The honest reading: don't do any of them until a feature genuinely needs the coordination overhead they buy. The current shape is not a limitation; it is a choice.

---
