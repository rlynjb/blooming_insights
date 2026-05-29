# Agent patterns in this codebase

Every agent loop in blooming insights, the pattern it instantiates, and the control envelope around it. The codebase is a **multi-agent system** in the **minimal multi-agent topology** — a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router for free-form questions, with the typed `Diagnosis` as the inter-stage message between the diagnostic and recommendation stages. Orchestration is **deterministic route code**, not an LLM supervisor — a deliberate "don't pay the coordination tax until you need it" choice. All four agents share one ReAct loop (`runAgentLoop` in `lib/agents/base.ts:48–176`); the differences are role, prompt, tool subset, budget, and output validator.

---

## The shared spine

Before the per-agent entries: every agent in this repo runs the same loop. `runAgentLoop` (`lib/agents/base.ts:48–176`) drives a Claude tool-use ReAct conversation where every `tool_use` block is dispatched through an injected `McpCaller` and the result fed back as `tool_result`. The loop terminates when (a) the model returns no `tool_use` blocks (natural end), or (b) `maxToolCalls` is hit — at which point the next turn is **forced**: tools are omitted from the request and a `synthesisInstruction` is appended to the system prompt, compelling the model to emit its final structured answer (`base.ts:90–98`). Model: `claude-sonnet-4-6` (`AGENT_MODEL`, `base.ts:9`) for all four agents; `claude-haiku-4-5-20251001` for the intent classifier (`lib/agents/intent.ts:14`). Tool results truncated at 16k chars (`MAX_TOOL_RESULT_CHARS`, `base.ts:29`). Both the Anthropic client and the MCP client are injected — every agent's tests use fakes, no network.

---

## Agents in this codebase

### Monitoring agent — the morning briefing

- **Feature:** Scans the workspace for significant recent changes and emits the top anomalies as ranked insight cards (`MonitoringAgent.scan`, `lib/agents/monitoring.ts:69–120`). Now takes a category checklist (`scan(hooks, categories)`) so the prompt only asks about categories the schema can support.
- **Pattern / shape:** ReAct on `runAgentLoop` + **capability gating** in front. Single-agent ReAct loop, scoped to `monitoringTools`, with a schema-gated category checklist injected via the `{categories}` slot in the prompt (`monitoring.ts:73–86`).
- **Why this pattern:** the workspace schema is large and the Bloomreach rate limit is ~1 req/s; the cheapest way to keep the loop honest is to scope its *checklist* before it spends any budget — the agent literally cannot fabricate alerts on categories that aren't on its list, because they aren't in its prompt.
- **Control envelope:** `maxToolCalls: 6` (`monitoring.ts:101`); forced final synthesis turn; output validated by `isAnomalyArray` (`lib/mcp/validate.ts`); on parse failure the agent returns `[]`, never a hallucinated list. Server-side severity sort + top-10 slice (`SEV_RANK` at `monitoring.ts:50`; applied at `:119`) is the only ranking surface in the codebase.
- **Eval:** the streamed `AgentEvent` trace (`lib/mcp/events.ts`) is the inspectable trajectory — every `reasoning_step`, `tool_call_start`, `tool_call_end` and the final anomaly array. There is no automated trajectory-eval harness; the ~169 vitest tests under `__tests__/` verify the loop's structural contracts with injected fakes.

### Diagnostic agent — why it happened

- **Feature:** Investigates one anomaly and produces a grounded `Diagnosis` — conclusion + evidence + `hypothesesConsidered` + optional `affectedCustomers` / `confidence` / `timeSeries` (`DiagnosticAgent.investigate`, `lib/agents/diagnostic.ts:45–83`).
- **Pattern / shape:** ReAct + **structured chain-of-thought**. The `hypothesesConsidered` field is the chain-of-thought escaping the conversation into the output schema, so it's inspectable rather than buried in the model's reasoning trace.
- **Why this pattern:** the diagnostic agent's job is *justified* conclusion — the evidence and the rejected hypotheses are part of the contract, not just the conclusion. A tool-less `synthesize()` retry (`diagnostic.ts:87–126`) is the recovery path when the main loop's forced-final turn fails to emit valid JSON — re-runs on a clean context, no tools. This is recovery, not self-critique (the model doesn't grade its own output; it just gets a clean shot at re-emitting it).
- **Control envelope:** `maxToolCalls: 6` (`diagnostic.ts:62`); forced final synthesis; output validated by `isDiagnosis`; `FALLBACK` diagnosis on total failure (`diagnostic.ts:16–19`); `confidence` derived by `diagnosisConfidence` in `lib/insights/derive.ts:54–63` (downgraded high→medium if any tool errored at `diagnostic.ts:80–82`) — an honest trust signal grounded in the run's evidence, not a self-reported one.
- **Eval:** streamed `AgentEvent` trajectory; the derived `confidence` is the agent's own honesty metric. No automated harness.

### Recommendation agent — what to do

- **Feature:** Turns an anomaly + diagnosis into up to three concrete Bloomreach actions, each tagged with feature, `estimatedImpact`, and optional `effort` / `timeToSetUpMinutes` / `prerequisites` / `successMetric` (`RecommendationAgent.propose`, `lib/agents/recommendation.ts:36–77`).
- **Pattern / shape:** ReAct + **id-less output** (server assigns ids). The model emits the recommendation body without an `id`; code at `recommendation.ts:76` assigns `crypto.randomUUID()`. Caps at 3.
- **Why this pattern:** recommendations are **suggestions** for the human to enact inside Bloomreach UI (a scenario, an email send, a segment) — they are **not** actions the agent takes. Server-side id assignment keeps the model's job small and the output trustworthy; the model never needs to invent a stable identifier, so the schema validator (`isRecommendationArray`) is checking content, not ids.
- **Control envelope:** `maxToolCalls: 4` (`recommendation.ts:57` — tighter than the others because the work is synthesis-heavy, not evidence-heavy); forced final synthesis; `isRecommendationArray` validates the id-less array shape; a dedicated `synthesize()` recovery (`recommendation.ts:82–132`); read-only MCP tools mean no side effect is structurally possible regardless of what the model emits.
- **Eval:** streamed `AgentEvent`; the typed `Recommendation[]` is the contract. No automated harness.

### Query agent — ask anything

- **Feature:** Answers a free-form natural-language question about the workspace with a tool-grounded prose answer (`QueryAgent.answer`, `lib/agents/query.ts:24–47`).
- **Pattern / shape:** ReAct + **prose output** (no schema validator — the answer is for the user to read). One-shot per question: `userPrompt: query` at `query.ts:35`; no conversation memory between calls.
- **Why this pattern:** the broadest tool set is needed because the question can be about anything; intent routing in front (`parseIntent` → `classifyIntent`) classifies what *kind* of question it is so the prompt can guide the agent's exploration, but the agent itself runs against the full tool surface. Prose output because a typed schema would be a straitjacket for an open question.
- **Control envelope:** `maxToolCalls: 6` (`query.ts:41`); forced final synthesis; the `?q=` input is only `.trim()`'d at `app/api/agent/route.ts:115` (an open prompt-injection surface, bounded by the read-only tool surface — see SECTION D's guardrails file).
- **Eval:** streamed `AgentEvent`; the final text is the answer. No automated harness; the read-only tool surface is the structural safety net.

### Intent classifier — routing the question

- **Feature:** Decides which agent path a `?q=` question takes (`parseIntent` heuristic at `lib/agents/intent.ts:6–12`, then `classifyIntent` haiku at `:17–31`).
- **Pattern / shape:** **Routing** — heuristic-first + LLM classifier on miss. Not an agent loop; one model call with `max_tokens: 16` forcing a one-word answer. Cross-references SECTION A's `06-routing.md`.
- **Why this pattern:** classification is high-volume and cheap-to-get-right; the heuristic resolves the obvious cases for free, and only ambiguous ones pay for the (already cheap) haiku model. This is the boundary between the free-form query path and the investigation pipeline.
- **Control envelope:** `max_tokens: 16` is the structural cap — the model literally cannot return more than a single category word. Wired in `app/api/agent/route.ts:211–212`.
- **Eval:** none separately — the downstream agent's output is the integration test.

### Coverage gate (anomaly-coverage schema gate) — scope before spend

- **Feature:** Before the monitoring agent runs, a cheap in-memory gate classifies a fixed 10-category anomaly checklist against the live workspace schema and hands the agent only the runnable categories (`lib/agents/categories.ts`: `schemaCapabilities` `:116–127` → `coverageFor` `:131–136` → `coverageReport` `:144–155` / `runnableCategories` `:158–160`; wired in `app/api/briefing/route.ts:202–204`, fed to `agent.scan(hooks, runnable)` at `:223`). The full report is streamed per-category to the feed's coverage grid; unsupported categories render as "no data source" ghost tiles.
- **Pattern / shape:** **Capability gating** — schema-driven feature detection, pre-loop. Not an agent; a deterministic classifier over the workspace schema returning a `runnable | needs_data | not_supported` verdict per category.
- **Why this pattern:** the agent's scarce resource is its ~1 req/s, `maxToolCalls`-capped budget. A free schema check up front means every spent call is on a category that can produce a result — the "scope before spend" rule. The same `coverageReport` doubles as the UI's coverage state, so the gate is load-bearing in two surfaces at once.
- **Control envelope:** pure function over the schema, no LLM, no budget. Tests cover its category-by-category verdicts with synthetic schemas.
- **Eval:** snapshot tests against representative schemas. No trajectory eval — there is no trajectory.

---

## Orchestration

### Deterministic sequential pipeline + message passing — not an LLM supervisor

- **Feature:** The investigation flow runs as `monitoring → diagnostic → recommendation`, each stage user-gated. Step 2 (`app/investigate/[id]/page.tsx`) runs ONLY the diagnostic agent (`/api/agent?step=diagnose`); step 3 (`app/investigate/[id]/recommend/page.tsx`) runs ONLY the recommendation agent (`/api/agent?step=recommend`), fed the diagnosis handed over from step 2. The route reads the `step` param at `app/api/agent/route.ts:117–118`, picks the lead agent at `:199–200`, and gates each agent at `:225–249`. The diagnose step writes its diagnosis to `sessionStorage` under `bi:diag:<id>` (`lib/hooks/useInvestigation.ts:138–139`); the recommend step reads it back and forwards it as `&diagnosis=` (`useInvestigation.ts:72–77, 162–163`). A null `step` is the legacy combined run (used by the demo-snapshot capture path).
- **Pattern / shape:** **Sequential pipeline** (SECTION C's `03-sequential-pipeline.md`) + **message passing** (SECTION C's `08-shared-state-and-message-passing.md`) where the message is a typed `Diagnosis`. Demo replay filters a cached combined-run trace down to one step's events via `filterByStep` (`route.ts:66–84`).
- **Why this pattern, not a supervisor:** the steps are knowable in advance (anomaly → diagnosis → recommendation is the product, not a dynamic plan), the user decides when each step runs (deferred-cost UX), and one source + one rate limit makes fan-out unprofitable. An LLM supervisor would add 2–5x coordination overhead, a larger debugging surface, and the conflict-merge failure mode, in exchange for zero benefit. The deliberate choice is to stay at the **minimal multi-agent topology**.
- **Control envelope:** Vercel `maxDuration = 300` (`route.ts:20`) caps the whole route at 5 minutes — a live diagnostic + recommendation run is ~100–115s under the rate limit, so 60s (Hobby) cannot fit it. Each agent's own `maxToolCalls` bounds its budget; the typed `Diagnosis` schema gates the inter-stage handoff (`parseDiagnosis` at `route.ts:86–97`); `McpClient` enforces 60s TTL cache, ~1.1s spacing, bounded exponential-backoff retry, no-cache-on-error.
- **Eval:** the streamed `AgentEvent` trace is the inspectable trajectory — both online (the user watches the agents work) and as a frozen replay artifact (`saveInvestigation` writes NDJSON; demo mode replays via `filterByStep`). No automated trajectory-eval harness.

---

## Closing note

Blooming insights deliberately stayed at the **minimal multi-agent topology** — four ReAct agents sharing one loop, one schema-driven capability gate, one intent router, and a deterministic sequential pipeline. The orchestration is route code, the inter-stage message is a typed value passed through `sessionStorage`, and the only "supervisor" is the URL `step` param.

This is the right answer to this codebase's actual problem (one upstream source, one rate limit, user-paced UX). The next escalations — supervisor-worker with an *LLM* supervisor, parallel fan-out across data domains, graph orchestration with checkpointed state and human-in-the-loop pauses — are mapped as concrete refactors in `06-orchestration-system-design-templates/`. The "how to make it apply" bullets in those templates name the files in this repo each refactor would touch. The honest reading: don't do any of them until a feature genuinely needs the coordination overhead they buy. The current shape is not a limitation; it is a choice.

---
Updated: 2026-05-29 — created
