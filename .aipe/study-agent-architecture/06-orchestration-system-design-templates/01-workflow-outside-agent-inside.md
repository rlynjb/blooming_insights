# Workflow outside, agent inside

- **The prompt:** "Design a system that proactively surfaces data anomalies to a business user, then investigates and recommends actions when the user asks — where the outer flow is knowable but the inner work needs the model's judgment."

- **Standard architecture:**

  ```
  User ──► UI (three phases: feed / investigate / recommend)
                              │
                              ▼ fetch + NDJSON reader
  ┌─ Service (Next.js route handler) ──────────────────────────┐
  │  DETERMINISTIC SUPERVISOR (TypeScript)                     │
  │  · classifyIntent (Haiku router, one call)                 │
  │  · dispatches: MonitoringAgent | DiagnosticAgent →         │
  │                RecommendationAgent (sequential)            │
  │  · streams NDJSON events to UI                             │
  └───────────────────────────┬────────────────────────────────┘
                              ▼ constructs worker
  ┌─ Worker agents (AptKit ReAct loops, autonomous inside) ────┐
  │  bounded by maxTurns=8, maxToolCalls=6                     │
  │  BudgetTracker check-before-dispatch on every model turn   │
  └───────────────────────────┬────────────────────────────────┘
                              ▼ tool_use via ToolRegistry adapter
  ┌─ DataSource port (Bloomreach | Synthetic | FaultInjecting) ┐
  │  minIntervalMs=1100 spacing gate + retry ladder            │
  └───────────────────────────┬────────────────────────────────┘
                              ▼ MCP over OAuth+PKCE
  ┌─ Bloomreach loomi connect (or synthetic fake) ─────────────┐
  └────────────────────────────────────────────────────────────┘
  ```

- **Data model:**

  - `WorkspaceSchema` — top 20 events, top 30 customer properties, catalog names; bounded compact summary injected into every agent's system prompt.
  - `Anomaly` — metric + scope + change + severity + evidence; monitoring's structured output.
  - `Diagnosis` — conclusion + evidence[] + hypothesesConsidered[]; diagnostic's structured output, handed to recommendation.
  - `Recommendation` — bloomreachFeature (enum: scenario|segment|campaign|voucher|experiment) + rationale + steps + estimatedImpact + confidence; recommendation's structured output.
  - `SessionFeed` — per-session `Map<sessionId, { insights, investigations, anomalies }>`; in-memory, scoped to prevent multi-user bleed.
  - `AgentEvent` (NDJSON contract) — reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error; the wire shape.
  - `ToolCall` trace — tagged by agent, forwarded to UI stream via `hooksFor(agent)`.

- **Key components:**

  - **Deterministic supervisor** (`app/api/agent/route.ts`) — TypeScript pipeline that picks and awaits each worker in a fixed order. Decision: deterministic over LLM supervisor for a knowable workflow (Anthropic's recommended posture), which saves ~20% cost + ~30% latency vs a Sonnet supervisor for this shape.
  - **Worker agents** (`lib/agents/*.ts`) — thin blooming wrappers over AptKit ReAct loops (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, plus `classifyIntent` Haiku router). Decision: task-shaped system prompts per agent, not one 400-line combined prompt (which the legacy `base-legacy.ts` proved caused mode confusion).
  - **DataSource port + adapters** (`lib/data-source/`) — one interface, three implementations (Bloomreach, Synthetic, FaultInjecting decorator). Decision: dependency-injected at construction; the port has already survived three swaps without agent-code changes.
  - **AptKit adapters** (`lib/agents/aptkit-adapters.ts`) — bridge Anthropic + MCP into AptKit's provider-neutral runtime. Decision: bridge instead of native — keeps MCP's ecosystem value AND AptKit's agent primitives.
  - **BudgetTracker** (`lib/agents/budget.ts`) — check-before-dispatch USD + token ceiling. Decision: code-side control, not prompt-side; prompts can be jailbroken.
  - **Prompt cache** (`aptkit-adapters.ts:87`) — ephemeral breakpoint on system prompt. Decision: five characters of code, ~78% input-side cost reduction after turn 1.
  - **Observability hook** (`onCapabilityEvent`) — raw event capture, downstream aggregation. Decision: single fire site, any-number-of-consumers pattern; avoids per-metric instrumentation.
  - **Streaming trace** (`ReasoningTrace` + `StatusLog`) — NDJSON events forwarded to UI. Decision: this is the product's differentiator ("an analyst that shows its work") — supervisor-worker's observability property is chosen for this reason.

- **Scale concerns:**

  - **At ~100 concurrent users on a single warm Vercel instance:** the `Map<sessionId, SessionFeed>` in-memory state grows; cold-start clears it. Threshold at which this hurts: when session bootstrap cost (workspace-schema fetch) starts dominating latency because too many users hit cold instances. Mitigation: move session state to Redis or an external cache.
  - **At ~10 investigations per second sustained:** the Bloomreach `minIntervalMs=1100` gate serializes everyone to 1 req/s per instance. Effective throughput is provider-bound, not compute-bound. Mitigation: request a higher Bloomreach rate limit; horizontally scaling instances doesn't help because Bloomreach's rate is global.
  - **At ~500 tool calls per investigation:** context-window bloat and per-turn cost start compounding. Threshold: probably ~100 turns per investigation. Mitigation: episodic memory tier (see `04-agent-infrastructure/02-agent-memory-tiers.md`) to summarize prior turns instead of accumulating.
  - **At USD $10 per investigation:** BudgetTracker fires, request degrades to a graceful error. Currently at ~$0.07 p50, three orders of magnitude of headroom.

- **Eval framing:**

  - **Golden receipts** (`eval/receipts/`) — per-case runs stored with tool calls, tokens, cost, diagnosis, recommendations. Reproducible with seeded PRNG.
  - **Trajectory eval:** tool-call accuracy (did diagnostic reach for the right EQL?), turn count vs baseline, cost per investigation.
  - **Output quality:** `eval/report.eval.ts` runs a Sonnet judge on rubrics (evidence quality, actionability, groundedness); judge calibrated against human ratings in `eval/calibration/`.
  - **Load harness** (`eval/load.eval.ts`) — N investigations at K concurrency with fault injection; the `2026-07-03T05-21-12-237Z` receipt shows 3 investigations, 9 injected faults, 0 failures, $0.21 total.
  - **Baseline pinned** (`eval/baseline.json`) — regressions caught when per-case cost or turn count drifts.
  - **Load-bearing metric:** per-case p50 cost ($0.07) and per-phase p50 latency (diagnose ~50s, recommend ~51s, judge ~38s+90s).

- **Common failure modes:**

  - **Runaway loop.** An agent stuck in an EQL-retry cycle burns tokens. Mitigation: BudgetTracker check-before-dispatch throws BudgetExceededError; AptKit maxTurns=8 catches shorter runaways.
  - **Rate-limit exhaustion.** Concurrent calls trigger 429s. Mitigation: `minIntervalMs=1100` spacing gate serializes ahead of the ceiling; retry ladder handles residual bursts with 10s waits (matching Bloomreach's penalty window).
  - **Malformed structured output.** Model returns Diagnosis missing `conclusion` or Recommendation with unknown `bloomreachFeature`. Mitigation: type guards in `lib/mcp/validate.ts` reject at seam; fixed feature enum makes unknown values unrepresentable.
  - **Tool failure.** Bloomreach times out or returns malformed content. Mitigation: `FaultInjectingDataSource` proves the shape — 9 injected faults / 3 investigations / 0 failed. AptKit presents failures as `is_error: true` tool results; the model reasons around them.
  - **Prompt injection on query flow.** User-controlled `q` param flows into `classifyIntent` and downstream. Mitigation: intent-enum classification narrows behavior; no explicit sanitizer today. Naming the gap honestly is stronger than pretending it's covered.
  - **Multi-tenant bleed.** Concurrent users on a warm instance. Mitigation: `Map<sessionId, SessionFeed>` scoped state; every mutation is per-session.

- **Applies to this codebase:** yes. This IS blooming_insights' architecture, verbatim. The three-phase UI (feed/investigate/recommend) maps 1:1 to three worker agents; the deterministic supervisor is `app/api/agent/route.ts`; the workers are AptKit ReAct loops in `lib/agents/*.ts`; the observability, cost, and fault-injection infrastructure are all in place per the receipts. Per-case cost $0.07, per-phase p50 diagnose 50s / recommend 51s, load receipt showing 9 faults / 0 failed.

- **How to make it apply:** already applies. The next-deepening pass has three natural targets. Episodic memory tier (`04-agent-infrastructure/02-agent-memory-tiers.md`) — retrieve prior investigations on repeat queries, saves ~30-50% on repeated cases. Prompt-injection sanitizer in front of `classifyIntent` — closes the thinnest guardrail gap. Graph orchestration (LangGraph or similar) — server-side pause/resume for a multi-actor approval flow. Each is a separate product decision, not a debt-repayment.
