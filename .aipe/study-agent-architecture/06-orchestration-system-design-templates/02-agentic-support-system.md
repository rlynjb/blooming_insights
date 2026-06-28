# Agentic support / task system

A generic interview-style design template, reframed against this codebase. **This is the closest match to what blooming insights actually is.** Nine bullets in the standard shape.

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools (ReAct) → guardrails (input sanitize, action gating, output schema) → human escalation on low confidence or gated actions:

```
  Standard agentic support / task system

  ┌─ Intent router ──────────────────────────────────────────┐
  │  classify user request: monitoring / diagnostic /         │
  │   recommendation / action                                  │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ Agent (ReAct) ──────────────────────────────────────────┐
  │  tools: read tools (always) + action tools (gated)        │
  │  ┌─ Guardrails ──────────────────────────────────────┐   │
  │  │  input: sanitize user text                         │   │
  │  │  loop: maxTurns + maxToolCalls + signal            │   │
  │  │  output: schema validation                          │   │
  │  │  action gate: pause before any side-effecting tool  │   │
  │  └─────────────────────────────────────────────────────┘   │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ Human escalation ───────────────────────────────────────┐
  │  on low confidence / gated action → human review          │
  └──────────────────────────────────────────────────────────┘
```

- **Data model:** conversation / run history with tool calls and confidence per turn (for audit + debugging); escalation log (which requests went to a human and why); tool registry (which tools the agent can see + which require gating); action audit trail (every side-effecting call, who approved, what changed).

- **Key components:**
  - **Routing** — classify intent before dispatching; heuristic-first then LLM-router for ambiguous cases
  - **The agent loop** — ReAct kernel with the four parts (`../01-reasoning-patterns/02-agent-loop-skeleton.md`)
  - **Guardrails** — full control envelope (`../04-agent-infrastructure/05-guardrails-and-control.md`)
  - **Escalation gate** — explicit human review for gated actions
  - **Audit logging** — full trace for after-the-fact debugging
  - **Decision per component:** which actions require human approval (irreversible / high-stakes) vs auto-execute (read-only / low-impact); shared state vs message-passing across multi-step requests

- **Scale concerns:**
  - **Tool-call cascade under load** — one flaky tool burns budgets across many concurrent requests (mitigation: per-tool circuit breaker, see `../05-production-serving/03-per-tool-circuit-breaking.md`)
  - **Cost per resolved request** — agent loops scale tokens with iteration count; budgets bound this
  - **Escalation queue as the human bottleneck** — if escalation rate climbs, humans become the latency bottleneck

- **Eval framing:**
  - **Resolution rate without escalation** — what fraction of requests does the agent handle end-to-end
  - **Tool-call accuracy** — did the agent call the right tools in the right order
  - **Adversarial set** — prompt injection attempts, out-of-scope requests, hostile inputs (defense should be the read-only tool grant — if no action tools, blast radius is small)
  - **Action-safety** — no unauthorized side effects, no actions outside the user's permission scope

- **Common failure modes:**
  - Prompt injection in user input (agent gets told "ignore previous instructions...") — primary defense is the tool-policy boundary: no action tools = no actions
  - Agent taking an unsafe action directly (mitigation: read-only by topology + explicit action gates for any side-effecting capability)
  - Infinite loop on an unsolvable request (mitigation: the kernel's budget exit)
  - Hallucinated tool results (mitigation: structural rule that every claim cites a real tool call's result)

- **Applies to this codebase:** **Yes — this is the closest match to what blooming insights is.** The product IS an agentic support system for a marketer: user clicks an anomaly → the diagnostic agent investigates → the recommendation agent proposes actions. The standard architecture maps as:
  - Intent router → `lib/agents/intent.ts` (one haiku call) + `app/api/agent/route.ts` URL routing
  - Agent → MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent (four ReAct loops)
  - Guardrails → per-agent budgets + AbortSignal + AptKit validators + the HTTP split before recommendations
  - Human escalation → the user reviewing every diagnosis in the EvidencePanel before approving recommendations
  - Audit logging → the streamed AgentEvent NDJSON trace + per-session investigation cache

  The one deviation from the standard template: **no action tools.** The RecommendationAgent is read-only by topology — it proposes Bloomreach actions (scenario / segment / campaign / voucher / experiment) as suggestions for a human to act on; it doesn't execute them. So "action gating" is degenerate — the user IS the action gate, every time. This is a deliberate safety choice: the worst-case outcome of an agent failure is "bad recommendation shown to user," not "wrong campaign sent to 10k customers."

- **How to make it apply:** Already applies — the closest match. The opportunities to deepen the alignment:
  1. **Add action tools (with explicit gating).** If the product moves toward "let the agent actually configure the Bloomreach scenario," add the execution tools to the RecommendationAgent's grant but gate them: every action requires explicit user approval in the UI before executing. This is the "human-in-the-loop pause" formalized as a tool-call-level gate.
  2. **Add per-tool circuit breaking.** The named gap from `../05-production-serving/03-per-tool-circuit-breaking.md`. Cuts the cost of Bloomreach flakiness from "burn whole budget" to "two attempts then route around."
  3. **Add an adversarial eval set.** Prompt-injection attempts, out-of-scope questions, hostile inputs — feed them through the QueryAgent (the only agent with free-form user input) and confirm the read-only tool grant contains the blast radius. The work: a small fixture file with adversarial inputs, replay through `SyntheticDataSource`, manual review of outputs.
