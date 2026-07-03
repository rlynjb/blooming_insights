# Agentic support / task system

*System design template · intent router + agent-with-tools + guardrails + escalation*

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools (ReAct) → guardrails (input sanitize, action gating, output schema) → human escalation on low confidence or gated actions.

```
  user request
    │
    ▼
  ┌────────────────────┐
  │  intent router      │  heuristic + LLM classifier
  │  (heuristic + LLM)  │
  └─────────┬──────────┘
            ▼
  ┌────────────────────┐
  │  agent (ReAct)      │
  │  with tool set      │  read + write tools
  │  scoped to intent   │
  └─────────┬──────────┘
            ▼
  ┌────────────────────┐
  │  guardrails         │  input sanitize
  │                     │  action gate (approval?)
  │                     │  output schema
  └─────────┬──────────┘
            ▼
  ┌────────────────────┐
  │  execute OR escalate│  human-in-the-loop
  │                     │  on low confidence or
  │                     │  gated actions
  └────────────────────┘
```

- **Data model:** conversation / run history with tool calls and confidence per turn, escalation log (which cases went to human, why), tool registry (with per-tool metadata: gated? auditable? reversible?), action audit trail (every write-tool call: agent + user + timestamp + reversibility flag).

- **Key components:** routing (see `01-reasoning-patterns/07-routing.md` — heuristic-then-LLM in production), the agent loop (ReAct baseline), guardrails (input sanitize, action gating, output schema — see `04-agent-infrastructure/05-guardrails-and-control.md`), escalation gate (which cases require human review), audit logging (write-tool traceability). Decision: which actions require human approval (irreversible / high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load (per-tool circuit breaker — `05-production-serving/03-per-tool-circuit-breaking.md`); cost per resolved request (baseline vs escalated); escalation queue as the human bottleneck (auto-tune the threshold when queue grows); rate-limits at write-tool providers (dedicated queues per external service).

- **Eval framing:** resolution rate without escalation (main quality metric); tool-call accuracy (right tool + right args); adversarial set (prompt injection, out-of-scope requests, jailbreak attempts); action-safety (no unauthorized side effects — measured against a golden "never do X" set); cost + latency per resolved case.

- **Common failure modes:** prompt injection in user input (input guardrail — see `04-agent-infrastructure/05-guardrails-and-control.md`); agent taking an unsafe action directly (action gate + never-let-agent-output-trigger-side-effects); infinite loop on an unsolvable request (iteration cap + budget exit); hallucinated tool results (structured output validation).

- **Applies to this codebase:** **partially**. Intent routing exists (`lib/agents/intent.ts` — Haiku classifier for free-form queries). Single-agent-with-tools exists (four ReAct agents). Guardrails exist (URL param validation, iteration caps, BudgetTracker, cancellation signals). What's missing: **write-tools and escalation**. Every MCP tool in this repo is read-only, so "the agent takes an action" isn't in scope — the agent produces Recommendation objects, and the user acts on them in Bloomreach. This is deliberate: an analyst product doesn't need write access to be useful.

- **How to make it apply:** three concrete changes.

  1. **Add write-tools.** Wire specific Bloomreach write-tools through MCP: `create_campaign`, `add_customer_to_segment`, `activate_scenario`. Each would need a metadata flag (`gated: true` for irreversible actions). New file: `lib/agents/action-gating.ts` — reads the tool metadata, decides "auto-execute vs pause for human approval." The gate lives at the DataSource layer (a `GatingDataSource` decorator), not the agent, so the agent literally cannot bypass it.

  2. **Add input prompt-injection scanner.** The current input guardrail is bounded (URL param validation + intent classifier bounds free-form queries). The moment write-tools ship, an adversarial user query could try to hijack the agent. First move: Anthropic's prompt-injection classifier on the free-form `q` input. Fallback: regex sanitizer for known attack patterns. Wire in `app/api/agent/route.ts` before `classifyIntent`.

  3. **Add escalation gate + human-in-the-loop.** Gated actions need a human-review flow: the agent proposes an action, the route stores it as "pending human approval," a notification fires (email / UI badge), a human reviews and approves/rejects. Requires a durable store (this repo has none today — new dependency: Postgres or KV). New file: `lib/state/pending-actions.ts`. Cross-refs `03-multi-agent-orchestration/07-graph-orchestration.md` — the escalation flow is a natural fit for graph orchestration's checkpointer, which persists state across the "pause for human" boundary.
