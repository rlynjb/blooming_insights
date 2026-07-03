# Agent evaluation

*Industry name: agent evals / trajectory eval · Industry standard*

## Zoom out

```
  Zoom out — evaluating an agent is not evaluating an LLM

  ┌─ LLM eval (one call) ─────────────────────────┐
  │  input → output → score                       │
  └───────────────────────────────────────────────┘
              ↓ expands to
  ┌─ ★ AGENT EVAL (a trajectory) ★ ────────────────┐ ← we are here
  │  input → tools called + order + errors +       │
  │          recovery + final output → score       │
  └────────────────────────────────────────────────┘
```

## Zoom in

Evaluating an agent is harder than evaluating one LLM call, because the unit of evaluation is the *trajectory*, not just the final output. The metrics that matter: task success rate, tool-call accuracy, trajectory efficiency (steps + cost to completion), recovery rate (did it handle a failed tool call). This repo's eval story: frozen golden trajectories + LLM-as-judge + fault-injection stress tests. Live — not retired.

## Structure pass

Layers: **input** (task, anomaly) — **trajectory** (tool calls, reasoning steps, errors, final output) — **judge** (scores against rubric) — **aggregation** (across many runs).

Axis to hold constant: **what specifically are you scoring?**

```
  Four axes of agent quality — pick the ones that matter

  1. Task success       final output is correct
  2. Tool-call accuracy right tools, right args, right order
  3. Efficiency         steps and cost to completion
  4. Recovery           handles tool failures, budget hits,
                        malformed responses
```

## How it works

### Move 1 — the shape

You've run a test suite before — many test cases, each with an assertion, aggregated to a pass rate. Agent eval is that shape scaled up: many test cases, each with a *trajectory* to score, aggregated by axis.

```
  LLM eval (one call):       Agent eval (a trajectory):
  ┌──────────────┐           ┌──────────────────────────┐
  │ input        │           │ was the right tool called?│
  │ → output     │           │ in the right order?       │
  │ → score      │           │ did it recover from errors│
  └──────────────┘           │ how many steps / $ / ms?  │
                             │ was the final output good?│
                             └──────────────────────────┘
```

### Move 2 — how eval works in this repo

**The eval story is live.** The eval harness runs regularly and produces the receipts referenced throughout this guide — the baseline runId `2026-07-03T04-08-28-644Z` (per-case ~$0.09; p50 diagnose 50s / recommend 51s / d-judge 38s / r-judge 90s) is one such run. This is not retired.

**Three eval mechanisms.**

1. **Frozen golden trajectories.** A committed set of recorded investigations (real anomalies, real ReAct traces, real Diagnoses, real Recommendations) serves as the regression corpus. When a code change ships, the eval harness replays or re-runs these cases and compares outputs. Drift on any axis (score, cost, latency) triggers investigation before merge.

2. **LLM-as-judge with rubric.** Two judges — diagnostic-judge and recommendation-judge — score each output on a rubric:

```
  Diagnostic judge — the rubric axes

  - conclusion grounded in evidence?    (yes / partial / no)
  - hypotheses actually considered?     (rubric bullets)
  - evidence cites real EQL results?    (fact check)
  - affected customers plausible?       (sanity)
  → aggregate score (0-5) + rationale
```

The judges are Sonnet (same family as the producer — noted caveat, see `03-multi-agent-orchestration/05-debate-verifier-critic.md`). The rubric mitigates same-family bias partially by grounding the score in structured axes rather than free judgment.

3. **Fault-injection stress tests.** `lib/data-source/fault-injecting.ts` wraps the DataSource with configurable failure rates (timeouts, 429s, 500s, malformed JSON). The receipt: **9 injected faults / 3 investigations / 0 failed** — the tier-2 graceful-degradation receipt. Every one of those faults hit the agent's observation loop and got routed around; nothing crashed the request.

**Trajectory metrics beyond the final output.**

```
  What the eval harness measures per trajectory

  1. Turn count       (how many ReAct iterations)
  2. Tool call count  (per tool, per turn)
  3. Cost             (via Blooming pricing helper — Anthropic-only,
                       aptkit's estimator is OpenAI-only)
  4. Latency          (per phase — schema bootstrap, list_tools,
                       intent classify, per-agent invocation)
  5. Error count      (transport errors, tool errors, model errors,
                       budget exits)
  6. Recovery events  (was an error observation reasoned around
                       successfully?)
  7. Final output     (Diagnosis + Recommendation, judged separately)
```

The `hooks.onCapabilityEvent` from `AgentHooks` captures every raw `CapabilityEvent` from aptkit's trace sink — the observability substrate for these metrics.

**The evaluator paradox.** Using an LLM to grade an LLM's trajectory is the whole eval-methodology problem. The mitigations this repo uses:

- **Frozen golden trajectories** as the regression corpus (deterministic replay, human-checked once).
- **Rubric-driven scoring** rather than free judgment (structured axes).
- **Cost + latency + error metrics** as hard signals (no LLM judgment involved).
- **Human spot-checks** on drift (when a score changes, a human looks at the trace before accepting the new baseline).
- **Iteration caps** so a runaway loop can't fake a good score by burning budget.

Cross-refs `.aipe/study-ai-engineering/07-evals/` for output-quality eval methods and LLM-as-judge bias mechanics; this file covers what's *additional* for agents — trajectory + tool-call evaluation.

**The receipt this eval story produces.** Every claim in this guide about the repo's shape is anchored to an eval artifact:

- p50 diagnose 50s — measured on the golden corpus.
- p50 recommend 51s — measured on the golden corpus.
- per-case ~$0.09 — via Blooming pricing helper on captured usage.
- 9 faults / 3 investigations / 0 failed — from a fault-injection run.
- 261 tests (+38 vs prior regen) — Vitest counts, agent loops TDD'd with injected fakes (no network).

These are the numbers that make the guide defensible. Without them, every claim is a promise; with them, it's evidence.

### Move 3 — the principle

The unit of agent evaluation is the trajectory, not the output. LLM eval scores one input-output pair; agent eval scores a whole path — tools chosen, order, errors, recovery, cost, latency. The mitigation for the LLM-judging-LLM paradox is layered: frozen goldens, rubric scoring, hard non-LLM metrics, human spot checks. Any one of these alone is insufficient; the combination is what makes the eval trustworthy.

## Primary diagram

```
  Agent eval — what this repo actually measures

  ┌─ Input: an Anomaly from the golden corpus ────────────────┐
  │  (real anomaly, previously investigated, human-checked)   │
  └─────────────────────────┬─────────────────────────────────┘
                            ▼
  ┌─ Run: DiagnosticAgent → RecommendationAgent ──────────────┐
  │  each hook fires:                                          │
  │    onCapabilityEvent   → raw aptkit events                 │
  │    onToolCall / Result → tool call trace                   │
  │    onText              → reasoning trace                   │
  │  BudgetTracker accumulates cost                            │
  └─────────────────────────┬─────────────────────────────────┘
                            ▼
  ┌─ Trajectory: capture everything ───────────────────────────┐
  │  { turns, tool_calls, cost, latency, errors,               │
  │    final_diagnosis, final_recommendations }                │
  └─────────────────────────┬─────────────────────────────────┘
                            ▼
  ┌─ Score across axes ────────────────────────────────────────┐
  │                                                            │
  │  ┌─ LLM-as-judge (diagnostic-judge, rec-judge) ─────┐      │
  │  │  rubric-driven scoring on conclusion,            │      │
  │  │  grounding, hypotheses, plausibility             │      │
  │  └────────────────────────────────────────────────── ┘      │
  │                                                            │
  │  ┌─ Hard metrics (no LLM) ──────────────────────────┐      │
  │  │  cost, latency, turn count, error count,         │      │
  │  │  recovery count                                  │      │
  │  └────────────────────────────────────────────────── ┘      │
  │                                                            │
  │  ┌─ Fault-injection stress ─────────────────────────┐      │
  │  │  FaultInjectingDataSource wraps DataSource       │      │
  │  │  configurable rates; measure survival            │      │
  │  └────────────────────────────────────────────────── ┘      │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
                            ▼
                     baseline receipts:
                       runId 2026-07-03T04-08-28-644Z
                       per-case ~$0.09
                       p50 diagnose 50s / recommend 51s
                       d-judge p50 38s / r-judge p50 90s
                       9 faults / 3 investigations / 0 failed
```

## Elaborate

Agent eval as a distinct discipline (from LLM eval) surfaced around 2023 with WebArena (Zhou et al.), AgentBench (Liu et al.), and Anthropic's SWE-bench work. The recurring finding: an agent that produces the "right final output" via a broken trajectory (wrong tool order, unnecessary retries, hallucinated intermediate steps) is worse in production than one that's slightly wrong but efficient — the broken trajectory means the model doesn't reliably know what it's doing.

The current frontier is **process-supervised eval** — scoring each intermediate step against a rubric, not just the final output. Anthropic's process-reward-model work and OpenAI's PRM800K dataset are the reference points. For product agents like this repo, the practical shape is what's here: golden trajectories + LLM-as-judge on final outputs + hard metrics on trajectory + fault injection for resilience. Full process supervision is expensive and adds its own bias risk.

## Interview defense

**Q: How do you eval this agent?**

Live eval harness, three mechanisms.

Frozen golden trajectories — a committed corpus of real anomalies with human-checked outputs. Every code change replays or re-runs the corpus and diffs against baseline.

LLM-as-judge with a rubric — diagnostic-judge and recommendation-judge score outputs on structured axes (grounded conclusion, hypotheses considered, plausible impact). The same-family bias caveat applies; the rubric mitigates it partially.

Fault-injection stress tests — `FaultInjectingDataSource` decorator wraps the DataSource with configurable timeouts, 429s, 500s, malformed JSON. Recent receipt: 9 injected faults across 3 investigations, 0 request failures. That's graceful-degradation measured, not asserted.

Baseline: runId `2026-07-03T04-08-28-644Z` — per-case ~$0.09; p50 diagnose 50s / recommend 51s; d-judge p50 38s; r-judge p50 90s.

*Anchor visual:* the axes + receipts diagram above.

**Q: What's the evaluator paradox and how do you handle it?**

Using an LLM to grade an LLM. Both share biases; the judge can rubber-stamp or share blind spots with the producer.

Mitigations, layered: (1) frozen golden trajectories with human-checked truth for regression, (2) rubric-driven scoring so the judge grades structured axes rather than free judgment, (3) hard non-LLM metrics (cost, latency, error count) that don't involve LLM opinion, (4) human spot-checks when scores drift.

The unmitigated risk is same-family judges (Sonnet judging Sonnet). If I ever hit correlated blind spots, the next move is swapping the judges to a different model family.

**Q: What breaks if you don't do trajectory eval?**

You get "right output via broken trajectory." The final Diagnosis looks fine, but the agent got there through 15 turns instead of 4, spent 5x expected cost, and made a bunch of wrong tool calls along the way. In production that's worse than a slightly-wrong-but-efficient trajectory — it means the model doesn't reliably know what it's doing, and the next input might trigger the broken path without the lucky recovery.

## See also

- **`01-context-engineering.md`** — context is one of the things the eval measures indirectly (bad context → bad trajectory).
- **`03-multi-agent-orchestration/09-coordination-failure-modes.md`** — what the fault-injection tests are guarding against.
- **`.aipe/study-ai-engineering/07-evals/03-llm-as-judge.md`** — LLM-as-judge bias mechanics.
