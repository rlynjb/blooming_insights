# Coordination failure modes

*Industry name: multi-agent coordination failures · Language-agnostic*

## Zoom out

```
  Zoom out — the failures that don't exist in single-agent systems

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker, pipeline, fan-out,        │
  │  debate, swarm, graph, shared state           │
  │                                               │
  │  ★ COORDINATION FAILURES (this file) ★        │ ← we are here
  │  (where the 2-5x overhead shows up)           │
  └──────────────────────────────────────────────┘
```

## Zoom in

Multi-agent introduces failures that don't exist in single-agent. Each has a specific mitigation. This file is where the "2-5x overhead" claim from `01-when-not-to-go-multi-agent.md` becomes concrete — these are the specific ways the overhead shows up and the specific controls that bound it.

## Structure pass

Layers: **failure type** — **where it originates** — **detection** — **mitigation**.

Axis to hold constant: **what specific thing breaks, and what specific control bounds it?**

Every entry below is a pair: the failure, then the mechanism you add to catch it. Nothing abstract.

## How it works

### Move 1 — the shape

You've had a component re-render loop before (a `useEffect` that updates state that fires the effect). The multi-agent version is worse because each iteration is a full LLM call — bugs are expensive, not just annoying. The pattern is: five specific failure modes, each with a specific mitigation. Learn the pairs.

```
  The five failures — pairs of failure + mitigation

  ┌──────────────────────┬───────────────────────────┐
  │ Failure              │ Mitigation                │
  ├──────────────────────┼───────────────────────────┤
  │ Infinite handoff     │ Handoff counter           │
  │ Tool-call cascade    │ Iteration + budget caps   │
  │ Context bloat        │ Message passing / routing │
  │ Synthesis failure    │ Schema-validated merge    │
  │ Cost blowup          │ Per-run token budget      │
  └──────────────────────┴───────────────────────────┘
```

### Move 2 — walk each pair

**Failure 1: infinite handoff.**

Swarm-shape topologies where A hands to B, B hands to A, no one commits to finishing. Symptom: request runs until the max duration timeout; no useful output; full budget burned.

Mitigation: **handoff counter at the runtime.** Cap total handoffs per request (say, 5). When hit, force stop or escalate to human. Not a hack — the counter is a load-bearing safety mechanism, the same as an iteration cap.

Not applicable in this repo (no swarm), but the same mechanic guards against any control-transfer loop.

**Failure 2: tool-call cascade.**

One agent triggers a storm of tool calls — either because it's exploring a wide space, or because it's stuck in a retry loop against a flaky tool, or because a fan-out agent spawned N sub-hypotheses each spawning M sub-calls. Symptom: a single request makes 100+ MCP tool calls; costs $2+; hits rate limits and starts failing.

Mitigation: **per-agent and global iteration caps + budget ceiling that halts the run.** In this repo, aptkit caps iterations per agent and the `BudgetTracker` caps the total across agents. Both are non-negotiable. Adding per-tool circuit breakers (`05-production-serving/03-per-tool-circuit-breaking.md`) is the next escalation for when a specific tool is dead.

**Failure 3: context bloat as agents accumulate shared state.**

Shared-state topologies where every agent reads the whole blackboard. Symptom: context grows past 100k tokens; lost-in-the-middle kicks in; agents miss information near the middle of their window; cost per turn balloons.

Mitigation: **message passing / context routing instead of a shared blackboard.** Each agent sees only what its role needs (see `08-shared-state-and-message-passing.md`). This repo defaults to message passing at the coordination layer for exactly this reason.

**Failure 4: synthesis failure.**

Fan-out topologies where the merger has to combine contradictory worker results. Symptom: two workers returned opposite findings; the merger averages them into a nonsense conclusion; or the merger picks one and silently drops the other; or the merger hallucinates a "reconciliation" that neither worker supports.

Mitigation: **validate worker outputs against a schema before synthesis; surface conflicts, don't average.** The merger's job is to detect the conflict and either (a) surface both findings + a flag, (b) re-query with a tie-breaker, or (c) escalate to human — never silently smooth it over. Structured worker output shapes with confidence scores are the substrate; the merger reads the confidence and reasons about it.

Not applicable in this repo today (no fan-out). Would apply the day the diagnostic parallelizes hypothesis testing.

**Failure 5: cost blowup.**

The 2-5x overhead compounds silently. Symptom: p95 cost per request drifts from $0.10 to $0.35 over weeks; no single decision was expensive, but the accumulated cost of "each stage takes 30% more than the previous one thought" adds up.

Mitigation: **per-run token budget + cheap models for workers, expensive only for the supervisor** (or, in this repo's case, cheap for the classifier/router and expensive for the actual reasoning workers). The `BudgetTracker` in this repo is the guardrail; `Blooming Anthropic pricing helper` (`lib/agents/pricing.ts`) makes the cost visible per turn.

Baseline: runId `2026-07-03T04-08-28-644Z`, per-case ~$0.09. If that drifts past ~$0.15 without a feature change, the alert should fire.

### Move 2.5 — how these show up in this repo's real receipts

**The fault-injecting decorator receipt.** `lib/data-source/fault-injecting.ts` wraps the DataSource and injects timeouts, 429s, 500s, and malformed JSON at configurable rates. The tier-2 receipt: **9 injected faults / 3 investigations / 0 failed.** That's coordination-failure resistance in concrete form — the agents' loops (Diagnostic + Recommendation) survived nine deliberate faults across three investigations without any request failing outright.

The mechanism that made this work: the agent observation loop is resilient to `isError: true` tool results. The tool result carries the error text; the agent's next turn reads it, reasons "that tool failed, let me try a different approach," and adapts. This turns a hard failure into a routed-around observation — which is the substrate for both failure-1 (infinite handoff prevention via observation) and failure-2 (tool-call cascade prevention via smart backoff).

**The budget ceiling receipt.** `BudgetTracker.exceeded()` is checked in `lib/agents/aptkit-adapters.ts:60` BEFORE every model call. When it fires:

```
  Budget exit — what happens in practice

  agent's next turn wants to dispatch to Anthropic
    │
    ▼
  AnthropicModelProviderAdapter.complete()
    │
    ▼
  if (this.budget?.exceeded()) throw new BudgetExceededError(...)
    │
    ▼
  aptkit's agent loop bubbles this up
    │
    ▼
  DiagnosticAgent.investigate() throws
    │
    ▼
  Route's try/catch emits graceful NDJSON error event
    │
    ▼
  UI shows a graceful "budget exceeded, try again" state
```

The check-before-dispatch shape is important — checking after the call would let one call slip past the ceiling. Checking before makes the ceiling exact.

### Move 3 — the principle

Every multi-agent topology carries a specific set of failures its topology introduces. Naming the pairs — failure + mitigation — is the interview-grade move. "We have a fan-out; we mitigate synthesis failure with schema-validated merge + confidence-weighted combination" beats "we have controls" as an answer.

## Primary diagram

```
  The five coordination failures + their mitigations

  ┌──────────────────────┬──────────────────────────────────────┐
  │ Failure              │ Mitigation                           │
  ├──────────────────────┼──────────────────────────────────────┤
  │ INFINITE HANDOFF     │ Handoff counter; force stop or       │
  │ A → B → A → B → …    │ escalate to human when hit           │
  │                      │ Applies to: swarm                    │
  ├──────────────────────┼──────────────────────────────────────┤
  │ TOOL-CALL CASCADE    │ Per-agent iteration cap (aptkit) +    │
  │ one agent triggers   │ global budget ceiling                │
  │ storm of calls       │ (BudgetTracker.exceeded())           │
  │                      │ + per-tool circuit breaker           │
  │                      │ Applies to: every topology           │
  ├──────────────────────┼──────────────────────────────────────┤
  │ CONTEXT BLOAT        │ Message passing / context routing    │
  │ agents accumulate    │ instead of shared blackboard         │
  │ shared state         │ Applies to: shared-state topologies  │
  ├──────────────────────┼──────────────────────────────────────┤
  │ SYNTHESIS FAILURE    │ Validate worker outputs against      │
  │ supervisor merges    │ schema before synthesis; surface      │
  │ contradictory        │ conflicts with confidence weighting; │
  │ results              │ don't silently average               │
  │                      │ Applies to: fan-out                  │
  ├──────────────────────┼──────────────────────────────────────┤
  │ COST BLOWUP          │ Per-run token/USD budget;            │
  │ 2-5x overhead        │ cheap models for workers,            │
  │ compounds silently   │ expensive only for supervisor        │
  │                      │ Applies to: every topology           │
  └──────────────────────┴──────────────────────────────────────┘
```

## Elaborate

Coordination failures are the multi-agent version of distributed-systems failures (partial failure, split-brain, thundering herd). The mitigations map cleanly: circuit breakers, budgets, backpressure, quorums, timeouts. The interesting difference is that the agents themselves can *reason about failures* — a tool that returns an error message can be routed around by the model's next turn — which is a resilience mechanism single-process systems don't have.

The frontier is **failure-mode-aware coordination** — supervisors that explicitly track worker health and route around failures at the orchestration layer, not just at the tool layer. LangGraph's `retry_policy` per node, CrewAI's `error_handler` per agent, and aptkit's per-invocation retry are early productions of this pattern.

## Interview defense

**Q: What multi-agent failures do you protect against?**

Five, each with a specific mitigation.

Tool-call cascade — an agent triggers a storm of calls. Guarded by aptkit's per-agent iteration cap plus the shared `BudgetTracker.exceeded()` check that runs before every model call. Baseline is $0.30 per investigation.

Cost blowup — the 2-5x overhead compounds silently. Guarded by the same tracker; per-case cost baseline is ~$0.09, and drift past ~$0.15 would alert.

Context bloat — every worker in this repo sees only what the route hands it, not a shared blackboard. Message passing at the coordination layer, scoped shared state only for resources (budget, schema, DataSource).

Synthesis failure — not applicable today (no fan-out). Would apply if I parallelized diagnostic hypothesis testing; mitigation would be typed worker outputs + confidence-weighted merge that surfaces conflicts instead of averaging.

Infinite handoff — not applicable (no swarm). Would apply if I moved to swarm; mitigation is a handoff counter with hard cap.

*Anchor visual:* the five-pairs table above.

**Q: What's your evidence these mitigations work?**

The fault-injecting decorator receipt: 9 injected faults across 3 investigations, 0 failed. That's the DataSource wrapped with `FaultInjectingDataSource` in `lib/data-source/fault-injecting.ts`, injecting timeouts, 429s, 500s, and malformed JSON at configurable rates. The agents' loops treat the `isError: true` result as an observation, reason "let me try a different approach," and adapt. That's coordination-failure resistance measured, not asserted.

**Q: Which failure is the sneakiest?**

Cost blowup. It's the only one that isn't loud — no error, no timeout, no user impact per-request. Just drift. Baseline is ~$0.09 per case; if that ever became $0.15 without a feature change, that's the alert. Guarding against it requires the `BudgetTracker` per-request AND external monitoring across requests. This repo has the per-request guard; the cross-request monitoring runs offline via the eval harness (`04-agent-infrastructure/04-agent-evaluation.md`).

## See also

- **`01-when-not-to-go-multi-agent.md`** — the 2-5x overhead claim this file made concrete.
- **`06-swarm-handoff.md`** — where infinite handoff applies.
- **`04-parallel-fan-out.md`** — where synthesis failure applies.
- **`08-shared-state-and-message-passing.md`** — where context bloat applies.
- **`05-production-serving/03-per-tool-circuit-breaking.md`** — the per-tool guard against tool-call cascade.
