# Agent evaluation

*Industry name: agent evaluation / trajectory evaluation — Industry standard.*

Evaluating an agent is harder than evaluating one LLM call, because the unit of evaluation is the *trajectory*, not just the final output. **In this repo, the streamed `AgentEvent` NDJSON trace IS the eval surface — but there is no automated trajectory-eval harness in the repo.** The honest framing: eval is by reading the trace.

## Zoom out — where this concept lives

In an automated-eval setup, the eval harness sits parallel to the production agent runtime — re-runs frozen inputs, captures trajectories, scores them. In this repo, there's no such harness; the eval is the streamed trace plus a human reading the StatusLog UI.

```
  Where eval lives in blooming insights (the honest version)

  ┌─ Production agent runtime ───────────────────────────────┐
  │  runAgentLoop → AgentEvent NDJSON stream                  │
  │   reasoning_step | tool_call_start | tool_call_end |      │
  │   insight | diagnosis | recommendation | done | error     │
  └──────────────────────┬────────────────────────────────────┘
                         ▼
  ┌─ Eval surface (the trace IS the eval) ───────────────────┐
  │  StatusLog UI shows every step as it happens              │
  │  user reads the trace and decides whether to trust it    │
  └──────────────────────────────────────────────────────────┘
  ┌─ Automated eval harness ─ NOT IN REPO ───────────────────┐
  │  No automated harness in the repo today                   │
  │  the AgentEvent contract is still the right substrate     │
  │  for trajectory eval if a harness gets rebuilt            │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what's the unit of evaluation?**

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

The trajectory expansion is what makes agent eval qualitatively different. You're scoring a sequence, not a point.

## How it works

### Move 1 — the mental model

You know snapshot testing in React — the test stores the rendered tree on the first run, then on each subsequent run compares the new tree against the stored snapshot and flags differences. Agent trajectory eval is the same idea, except the "tree" is the sequence of (thought, tool_call, tool_result) tuples the agent produced. Frozen trajectories are your snapshots; new runs are compared against them.

```
  Agent eval surface — what to score

  ┌─ Per turn ─────────────────────────────────────┐
  │  was the reasoning consistent with the data?   │
  │  was the tool call appropriate for the goal?   │
  │  did the tool error get handled?               │
  └────────────────────────────────────────────────┘

  ┌─ Per trajectory ───────────────────────────────┐
  │  task success rate (did it finish?)             │
  │  tool-call accuracy (right tools?)              │
  │  trajectory efficiency (steps / cost / latency) │
  │  recovery rate (handled a flaky tool?)          │
  └────────────────────────────────────────────────┘

  ┌─ Per output ───────────────────────────────────┐
  │  final answer quality (grounded? complete?)     │
  │  schema validity (parses?)                      │
  └────────────────────────────────────────────────┘
```

### Move 2 — what's actually evaluable in this repo

**The streamed AgentEvent NDJSON contract is the eval substrate.**

From `lib/mcp/events.ts:4-12`:

```typescript
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Every agent trajectory IS a sequence of these events. You can read them top-to-bottom and reconstruct exactly what the agent did — which tools, in what order, with what results, with what reasoning. This is the substrate any trajectory-eval harness would consume.

**The capture path saves trajectories to disk.**

When `step == null` (the combined-run capture path), the route handler saves the full collected event array:

```typescript
// app/api/agent/route.ts:302
if (step == null) saveInvestigation(insightId!, collected);
```

These saved trajectories become `lib/state/demo-investigations.json` for the demo replay. The same shape would be a frozen-input fixture for an automated eval — except no harness reads them for scoring purposes today.

**Per-phase wall-clock timing is logged server-side.**

Both routes log a per-phase summary on every request:

```typescript
// app/api/briefing/route.ts:316-324 — fires even on error
console.log(JSON.stringify({
  route: '/api/briefing',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,
  aborted: req.signal.aborted,
}));
```

`phases` is an array of `{ phase, durationMs }` covering schema_bootstrap, coverage_gate, list_tools, monitoring_scan, etc. This is the trajectory efficiency signal — how much of the 300s budget was burned where.

**Token usage is logged per LLM call.**

The `AnthropicModelProviderAdapter` logs `usage` on every Anthropic call (`lib/agents/aptkit-adapters.ts:57-61`):

```typescript
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

Same pattern in the legacy `runAgentLoop` (`base-legacy.ts:135`). This is the cost signal — input/output tokens per call, joinable by sessionId.

**The validators are the "did the output parse" eval.**

Each AptKit agent has a validator that runs after the loop's final text — `tryParseAnomalies`, `tryParseDiagnosis`, `validateRecommendations`. If the parse fails, the recovery turn fires. If recovery also fails, the agent returns the empty/fallback shape. These validators are *implicit eval at the output boundary* — they don't score, but they catch malformed trajectories.

### Move 2.5 — what's NOT in this repo, and why

**No automated trajectory-eval harness.** The honest current state: trajectory eval is the streamed trace plus a human reading it. No regression suite for trajectory shape; no LLM-as-judge scoring per turn; no aggregate metrics dashboard. The streamed `AgentEvent` NDJSON contract IS the inspectable trajectory — it's the right substrate for a harness, just not yet wired to one.

What the harness would consume if rebuilt:
- Frozen inputs: anomalies in `lib/state/demo-insights.json`
- Frozen golden trajectories: investigations in `lib/state/demo-investigations.json`
- Per-trajectory metrics: turn count, tool call count, tokens used (already logged), wall-clock time (already logged)
- Scoring: LLM-as-judge per dimension (groundedness, hypothesis diversity, conclusion quality) plus structural rules (every evidence item cites a tool call)

What's missing (the work):
- A test runner that drives `runAgentLoop` with frozen inputs (the AbortSignal contract makes this straightforward — no real Bloomreach needed if you use SyntheticDataSource)
- A scorer module (LLM-as-judge + structural rules)
- A baseline metrics file checked into the repo, with regression alerts when trajectories diverge significantly

The natural opportunity: when the product team commits to "this is the agent's quality target," that target becomes the metric the harness scores against. Without the target, the harness has nothing to alert on.

### Move 3 — the principle

Agent eval is harder than LLM eval because the unit is the trajectory — a sequence of (thought, action, observation) tuples — not a point. The metrics that matter for agents: task success rate, tool-call accuracy, trajectory efficiency, recovery rate. The **evaluator paradox** is real: using an LLM to grade an LLM's trajectory inherits the grader's biases. Controls: frozen golden trajectories (you compare against, not just LLM-score), iteration caps (limit how many times the scorer can disagree), human spot-checks (sample real trajectories regularly).

In this repo, the honest framing is the streamed trace plus a human reviewer. That's a real eval surface — every reasoning step, every tool call, every result is visible in the StatusLog UI. It's just not *automated*. When the product moves to higher autonomy or higher volume, automating the trace-reading is the natural next investment.

## In this codebase

**Partial — by reading.** The streamed `AgentEvent` NDJSON contract IS the inspectable trajectory. Every reasoning step and tool call is in the trace; the user can read it in the StatusLog. No automated harness in the repo today. Per-phase timings and per-call token usage ARE logged server-side, so the cost/latency dimensions of eval are available — they're just not aggregated into a metrics dashboard.

The case for adding back an eval harness: when the product needs to catch trajectory regressions before they ship. Today a prompt change that makes the diagnostic agent waste tool calls on irrelevant hypotheses wouldn't be caught by any automated test — the trajectory might still parse, the diagnosis might still look plausible, but the *trajectory efficiency* dropped. An eval harness with frozen golden trajectories would alert on that.

## Primary diagram

The eval surface as it exists in this repo:

```
  Agent eval in blooming insights — the trace IS the eval

  ┌─ Per-call dimension (LOGGED, not scored) ────────────────┐
  │  AnthropicModelProviderAdapter logs usage per call        │
  │  → input/output tokens, joinable by sessionId             │
  │  → cost signal: $/run, $/agent, $/category                │
  └──────────────────────────────────────────────────────────┘

  ┌─ Per-phase dimension (LOGGED, not scored) ───────────────┐
  │  routes log phases: schema_bootstrap, coverage_gate,      │
  │   list_tools, monitoring_scan, diagnostic_investigate,    │
  │   recommendation_propose                                   │
  │  → latency signal: wall-clock per phase                   │
  └──────────────────────────────────────────────────────────┘

  ┌─ Per-trajectory dimension (STREAMED, read by human) ─────┐
  │  AgentEvent NDJSON to the client: reasoning_step,         │
  │   tool_call_start, tool_call_end, insight, diagnosis,     │
  │   recommendation, done, error                              │
  │  → quality signal: a human reads the StatusLog            │
  │  ★ no automated scoring; the user IS the scorer ★         │
  └──────────────────────────────────────────────────────────┘

  ┌─ Per-output dimension (VALIDATED, implicit eval) ────────┐
  │  AptKit validators: tryParseAnomalies, tryParseDiagnosis, │
  │   validateRecommendations                                  │
  │  → schema-validity signal; on failure, recovery turn fires │
  └──────────────────────────────────────────────────────────┘

  ┌─ What's missing: AUTOMATED HARNESS ──────────────────────┐
  │  no frozen-input regression suite                          │
  │  no LLM-as-judge per turn                                  │
  │  no aggregate metrics dashboard                            │
  │  no automated harness wired today                          │
  └──────────────────────────────────────────────────────────┘
```

## Interview defense

**Q: "How do you evaluate your agents?"**

A: Honestly — by reading the streamed trace. The `AgentEvent` NDJSON contract carries every reasoning step, tool call, and result; the StatusLog UI surfaces all of them as they happen; the user is the scorer. Per-call token usage is logged server-side (`AnthropicModelProviderAdapter` in `lib/agents/aptkit-adapters.ts:57`), per-phase wall-clock is logged at the route level (`app/api/briefing/route.ts:317`), and the AptKit validators catch shape errors at the output boundary. What's NOT in the repo: an automated trajectory-eval harness. The streamed AgentEvent contract is the right substrate for a harness — every trajectory is already on the wire as inspectable events — but no harness is wired to consume it for regression scoring today.

The dimensions a rebuilt harness would score:
- **Per-trajectory metrics** — turn count, tool call count, tokens, latency (already logged; just needs aggregation)
- **Tool-call accuracy** — did the agent call the right tool for the step? (LLM-as-judge per turn)
- **Trajectory efficiency** — did it complete in fewer turns than baseline? (compare against frozen golden trajectories)
- **Recovery rate** — when a tool errored, did the agent handle it gracefully? (replay scenarios with synthetic tool errors via SyntheticDataSource)

The implementation seam already exists — `SyntheticDataSource` lets you drive `runAgentLoop` deterministically without hitting Bloomreach. The missing pieces are the runner, the scorer, and the baseline metrics file checked into the repo.

Diagram I'd sketch:

```
  what we have:                            what an automated harness adds:
  ┌─ AgentEvent NDJSON ─┐                  ┌─ frozen inputs ──────┐
  │  full trajectory     │                  │  demo-insights.json  │
  │  visible in UI       │                  └──────────┬───────────┘
  └─────────┬────────────┘                             ▼
            │                              ┌─ replay runner ──────┐
            ▼                              │  drives runAgentLoop │
  ┌─ human reads trace ─┐                  │  via SyntheticDataS  │
  │  decides quality     │                  └──────────┬───────────┘
  └──────────────────────┘                             ▼
                                            ┌─ scorer ─────────────┐
                                            │  LLM-as-judge        │
                                            │  + structural rules   │
                                            └──────────┬───────────┘
                                                       ▼
                                            ┌─ metrics dashboard ──┐
                                            │  baseline + alerts   │
                                            └──────────────────────┘
```

Anchor: "the streamed AgentEvent contract IS the trajectory — every reasoning step, every tool call. Today the user reads it; tomorrow the harness reads it. The substrate is already shipped."

**Q: "What's the evaluator paradox and how would you address it?"**

A: Using an LLM to grade an LLM's output inherits the grader's biases — same-family models share blind spots, so a Claude grader on a Claude trajectory will rationalize the same kinds of errors it would have made. Three controls. First, frozen golden trajectories — you compare new runs against a stored canonical, so the "did this drift" question doesn't need a scorer at all. Second, structural rules — "every evidence item cites a real tool call" is checkable in code, no LLM needed. Third, different-model-family scorer — when you do need LLM-as-judge, use a model from a different vendor than the producer so the bias profiles don't align. For this repo, a haiku scorer on a sonnet producer is the cheap first step (different size, partial protection); a GPT or Gemini scorer would be the fuller version.

## See also

- [`05-guardrails-and-control.md`](./05-guardrails-and-control.md) — validators are implicit eval at the output boundary
- [`../03-multi-agent-orchestration/05-debate-verifier-critic.md`](../03-multi-agent-orchestration/05-debate-verifier-critic.md) — the live-time version of eval (critic in the loop)
- [`../01-reasoning-patterns/05-reflexion-self-critique.md`](../01-reasoning-patterns/05-reflexion-self-critique.md) — the single-agent version
- ai-engineering's evals files (cross-ref) — output-quality eval methods, LLM-as-judge bias
