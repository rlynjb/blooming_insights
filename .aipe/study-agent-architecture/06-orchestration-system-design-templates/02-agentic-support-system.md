# Agentic support / task system

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."

- **Standard architecture:**

  ```
  User request
       │
       ▼
  ┌─ Intent router (Haiku) ───────────────────────────────────────┐
  │  classifies: billing | tech | account | fraud | unknown       │
  └───────────────────────────┬───────────────────────────────────┘
                              ▼
  ┌─ Input guardrail ─────────────────────────────────────────────┐
  │  sanitize prompt-injection patterns; enforce max length       │
  └───────────────────────────┬───────────────────────────────────┘
                              ▼
  ┌─ Support agent (ReAct with action-shape tools) ───────────────┐
  │  tools:  read customer, issue refund*, update profile*,       │
  │          create ticket, escalate*     (* = gated actions)     │
  │  guardrail: gated actions require action-approval token       │
  └───────────┬──────────────────────────────────┬────────────────┘
              │ confidence >= threshold          │ confidence < threshold
              ▼                                  ▼
       auto-resolve                        escalate to human
       write audit log                     escalation queue
  ```

- **Data model:**

  - Conversation history — turn-by-turn user messages + agent responses + tool calls, per request-thread.
  - Tool registry — the set of callable actions with per-tool metadata (gated / auto, cost estimate, side-effect flag).
  - Action audit trail — every side-effect action logged (who, what, when, agent confidence, request thread).
  - Escalation queue — pending human reviews with agent's proposed action, evidence, and confidence.
  - Confidence signals — per-turn score used to decide auto-resolve vs escalate (from calibration data).
  - Customer state — the target of most actions; usually external (CRM), read-through cache locally.

- **Key components:**

  - **Intent router** — Haiku-tier LLM classifies free-form user request into a fixed intent enum. Decision: cheap classifier at the top, cascade to the specialist agent (same cascade blooming uses for `classifyIntent`).
  - **Input guardrail** — regex/rule-based sanitizer + prompt-injection heuristics. Decision: code-side, not prompt-side, for the same jailbreak reasons blooming applies to BudgetTracker.
  - **Support agent (ReAct loop)** — one autonomous loop with the action-shape tool set. Decision: single-agent instead of multi-agent unless specialties genuinely differ (billing vs fraud have different failure modes and different tools, so multi-agent may earn its keep here — contrast with blooming's three-agent split for the three product phases).
  - **Action gating** — irreversible / high-stakes actions (refund, delete, unsubscribe) require an approval token that the agent cannot mint itself. Decision: the model NEVER touches side effects directly; a code-layer harness runs them.
  - **Escalation gate** — confidence threshold + gated-action detection routes to a human queue. Decision: default to escalation on ambiguity; auto-resolve is opt-in per intent.
  - **Audit logger** — every side-effect action, whether auto-resolved or escalated, written to an append-only log. Decision: mandatory, not opt-in — regulatory and debugging both need it.

- **Scale concerns:**

  - **At ~10 requests per second sustained:** LLM cost dominates. Threshold: batch classification (multiple queries per Haiku call) if cost-per-request exceeds business threshold. Mitigation: cascade (cheap Haiku classifier → expensive Sonnet loop only when needed).
  - **At ~10% escalation rate:** human review queue becomes the bottleneck. Threshold: queue depth > 30 minutes of human capacity. Mitigation: raise auto-resolve confidence threshold selectively per intent, or add specialist queues by intent.
  - **At ~1% adversarial rate:** prompt injection attempts start slipping past the sanitizer. Threshold: any auto-executed action that shouldn't have been. Mitigation: add a "second-opinion" gate — separate model reviews any high-stakes proposed action before dispatch.
  - **At ~5s p50 latency:** users perceive lag. Threshold: response cycle > 3s. Mitigation: streaming first-token response, cached tool results per session, cheaper Haiku model on simple intents.

- **Eval framing:**

  - **Resolution rate without escalation** — the primary business metric. Higher is better *only* if action-safety holds; the two must be measured together.
  - **Tool-call accuracy** — did the agent call the right tool for the request? Measured against a golden set of representative cases per intent.
  - **Action safety** — auto-executed actions verified against ground truth. Zero-tolerance metric for false positives on gated actions.
  - **Adversarial set** — prompt-injection attempts, out-of-scope requests, edge cases. Rejected-vs-attempted ratio.
  - **Escalation quality** — of escalated cases, what fraction did the human agree with? Low agreement means the agent's confidence is miscalibrated.
  - **Cost per resolved request** — bounds the business case.

- **Common failure modes:**

  - **Prompt injection in user input.** Malicious user tries to override system instructions to trigger an unauthorized action. Mitigation: input guardrail sanitizer + gated actions requiring approval tokens + audit log.
  - **Agent taking an unsafe action directly.** Model decides to issue a refund when the case doesn't warrant. Mitigation: gated actions are code-layer, not prompt-layer — model emits intent, harness enforces approval.
  - **Infinite loop on unsolvable request.** Agent keeps trying variations of a bad tool call. Mitigation: iteration cap (maxTurns) + BudgetTracker + fallback to escalation after N failed turns.
  - **Hallucinated tool results.** Model imagines a tool result and reasons on it. Mitigation: never let the model produce tool_result blocks; the harness owns tool execution.
  - **Escalation queue backlog.** Human bottleneck under load. Mitigation: monitor queue depth; degrade to "we're experiencing high volume" auto-response with delayed escalation.
  - **Confidence miscalibration.** Model's stated confidence doesn't match ground-truth success rate. Mitigation: post-hoc calibration curve; recalibrate thresholds monthly.

- **Applies to this codebase:** no. Blooming has no autonomous actions — recommendations are surfaced to a human who acts. There's no action-gating layer, no escalation queue, no audit trail (aside from the reasoning trace, which is UX not compliance). The user IS the action-taker; blooming is a *recommender*, not a *doer*. This is the load-bearing distinction: blooming's recommendation output goes to a card the user reads, not to a `POST /scenarios` call the agent executes.

- **How to make it apply:** significant refactor. Three components would need to land. (1) An action-shape tool set — today the Bloomreach MCP surface exposes read-mostly tools (`execute_analytics_eql`, `list_scenarios`); adopting requires write-tools (`create_scenario`, `start_experiment`) which Bloomreach may or may not expose. (2) Action gating — the RecommendationAgent's output would go through an approval token check before dispatch; a gated action requires user confirmation. (3) Audit log — every dispatched action logged with agent confidence, evidence, and reasoning trace. Blooming's `AgentEvent` NDJSON contract could extend into this, but the trace would need to be persisted (currently ephemeral). Estimated effort: multi-week; the shape shift from "recommender" to "action-taker" is a product decision, not a code decision.
