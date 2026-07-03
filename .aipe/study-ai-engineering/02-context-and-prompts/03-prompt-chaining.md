# Prompt chaining

## Subtitle

Multi-stage LLM pipeline / sequential agent handoff — Industry standard.

## Zoom out, then zoom in

The investigation flow in this codebase is a two-step prompt chain: **diagnostic agent** produces a `Diagnosis`, then **recommendation agent** takes that `Diagnosis` plus the original `Anomaly` and produces a `Recommendation[]`. Each step is its own agent with its own system prompt, its own tool set, its own model call loop. The output of step 1 becomes part of the input to step 2. The user sees them as two clicks — "investigate" then "see recommendations →" — but they're one chain.

```
  Zoom out — the two-step chain

  ┌─ Feed (anomaly card) ───────────────────────────────┐
  │  user clicks investigate                             │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Step 2 — Diagnostic ──────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly)               │
  │  → Diagnosis { conclusion, evidence,                │
  │                hypothesesConsidered }               │
  └───────────────────────┬──────────────────────────────┘
                          │  handed off via
                          │  route: ?step=recommend
                          │  cache: getCachedInvestigation
                          ▼
  ┌─ Step 3 — Recommendation ★ ─────────────────────────┐ ← chain step 2
  │  RecommendationAgent.propose(anomaly, diagnosis)     │
  │  → Recommendation[] with steps + expected impact     │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the chain isolates concerns. Step 1's job is "what happened and why." Step 2's job is "what to do about it." Each step has one job.

## Structure pass

- **Layers:** UI trigger → diagnostic → handoff → recommendation → UI render. Five bands.
- **Axis: what each step owns.** Diagnostic owns *understanding*. Recommendation owns *action*. The handoff carries the diagnosis object across the seam.
- **Seam:** the `Diagnosis` object. It's the contract between the two agents. Recommendation agent trusts it; diagnostic agent produces it against its rubric.

## How it works

### Move 1 — the mental model

Prompt chaining is the answer to "each LLM call should have one job." A single agent asked "diagnose this AND recommend actions" would do both worse than two agents each doing one. The chain lets you:

- Use different tools for each step (diagnostic needs EQL queries; recommendation may not).
- Score each step separately (the eval has two rubrics — one per step).
- Cache the intermediate result (a re-render of step 3 doesn't re-run step 2).

```
  Chain vs monolith — the shape

  Monolith (banned pattern):
  ┌───────────────────────────────┐
  │  One prompt: diagnose AND recommend │
  │  → mixed reasoning, mixed rubric    │
  │  → hard to score, hard to cache     │
  └───────────────────────────────┘

  Chain (this codebase):
  ┌─────────────────┐    ┌──────────────────┐
  │  Step 1:        │───▶│  Step 2:         │
  │  Diagnose        │    │  Recommend       │
  │  (own tools,     │    │  (own tools,     │
  │   own rubric,    │    │   own rubric,    │
  │   own model call)│    │   own model call)│
  └─────────────────┘    └──────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Step 1 — diagnostic.** `lib/agents/diagnostic.ts:47` — `DiagnosticAgent.investigate(anomaly)`:

- Input: an `Anomaly` from the monitoring scan (or from the feed's insight cache).
- Tools: full MCP tool set — the agent picks what it needs.
- Loop: 5–10 turns, alternating thought → EQL query → tool result → thought → ...
- Output: `Diagnosis { conclusion, evidence[], hypothesesConsidered[], affectedCustomers? }`. Schema in `lib/mcp/types.ts:30-46`.

**The handoff.** The route (`app/api/agent/route.ts`) invokes step 1 or step 2 based on the `?step=diagnose|recommend` query param. When step 2 runs:

- It calls `getCachedInvestigation(sessionId, insightId)` in `lib/state/investigations.ts` — the diagnosis from step 1 is already cached.
- If cache miss, it runs the combined chain (used only by the demo-snapshot capture path).
- The recommendation agent receives both the `Anomaly` and the cached `Diagnosis`.

**Step 2 — recommendation.** `lib/agents/recommendation.ts:26` — `RecommendationAgent.propose(anomaly, diagnosis)`:

- Input: original anomaly + step 1 diagnosis.
- Tools: same MCP tool set — the recommendation agent may pull further data to size impact, but often doesn't.
- Loop: 4–8 turns.
- Output: `Recommendation[]` — each with `title`, `rationale`, `bloomreachFeature`, `steps[]`, `estimatedImpact`, `confidence`.

**Why the caching matters.** The user might click "see recommendations →", then click back, then forward again. Without caching, each round trip re-runs step 1 (~50s). With caching, step 1 runs once per anomaly per session, and step 2 runs each time it's needed (still fresh — user may want a different rec set on a rerun).

Diagram of one full chain execution:

```
  Two-step chain — layers-and-hops

  ┌─ UI feed ─────┐  hop 1: click investigate       ┌─ /api/agent ──┐
  │ InsightCard   │ ──────────────────────────────► │ step=diagnose │
  └───────────────┘  hop 4: diagnosis via NDJSON ◄─ └──────┬────────┘
                                                     hop 2 │ investigate()
                                                           ▼
                                                    ┌─ DiagnosticAgent ┐
                                                    │  5-10 turns      │
                                                    │  emit reasoning, │
                                                    │  tool_call events│
                                                    └──────┬───────────┘
                                                     hop 3 │ Diagnosis
                                                           ▼
                                                    saveInvestigation()
                                                    (state/investigations.ts)

  ┌─ UI /recommend ┐ hop 5: click "see recs →"      ┌─ /api/agent ──┐
  │ page.tsx      │ ──────────────────────────────► │ step=recommend│
  └───────────────┘  hop 8: rec[] via NDJSON ◄───── └──────┬────────┘
                                                     hop 6 │ propose(anomaly, cached diagnosis)
                                                           ▼
                                                    ┌─ RecommendationAgent┐
                                                    │  4-8 turns          │
                                                    └──────┬──────────────┘
                                                     hop 7 │ Recommendation[]
                                                           ▼
                                                    stream back
```

### Move 3 — the principle

If a task has two shaped-differently outputs, use two chains. The isolation buys you: separately scorable rubrics, separately cacheable steps, separately swappable models (recommendation could run on a smaller model if you validated the quality). The single-agent version couldn't offer any of that.

## Primary diagram

```
  Two-step chain — full frame

  ┌─ Anomaly (from monitoring scan) ───────────────────────┐
  │  { metric, scope, change, severity, evidence, impact }  │
  └───────────────────────┬────────────────────────────────┘
                          │
                          ▼
  ┌─ Step 1: DiagnosticAgent ──────────────────────────────┐
  │                                                         │
  │  system prompt: "you are a data analyst; find the       │
  │                  root cause; cite evidence"             │
  │  tools: full MCP tool set (EQL, segments, funnels)      │
  │  loop: ReAct, 5-10 turns                                │
  │                                                         │
  │  → Diagnosis {                                          │
  │      conclusion: "payment_failure_rate spike ...",      │
  │      evidence: [...],                                   │
  │      hypothesesConsidered: [...]                        │
  │    }                                                    │
  │                                                         │
  │  scored by: eval/rubrics/diagnosis-quality.ts           │
  │             (4 dims × 5 scale)                          │
  └───────────────────────┬────────────────────────────────┘
                          │  saveInvestigation()
                          │  getCachedInvestigation() on rerun
                          ▼
  ┌─ Step 2: RecommendationAgent ──────────────────────────┐
  │                                                         │
  │  system prompt: "given this diagnosis, propose          │
  │                  concrete Bloomreach actions"           │
  │  tools: MCP tool set (used sparingly)                   │
  │  loop: ReAct, 4-8 turns                                 │
  │                                                         │
  │  → Recommendation[] {                                   │
  │      title, rationale, bloomreachFeature,               │
  │      steps[], estimatedImpact, confidence               │
  │    }                                                    │
  │                                                         │
  │  scored by: eval/rubrics/recommendation-quality.ts      │
  │             (4 dims × 5 scale)                          │
  │  ↑ this rubric's diagnosis_response dim (48% pass rate) │
  │    catches the "pause A/B when root cause is payment"   │
  │    failure that recurs in cases 01 + 08                 │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Prompt chaining is one of the oldest patterns in LLM engineering — it predates agents by a couple of years. The tradeoff versus a monolithic prompt: more latency (sequential calls), more cost (two full context loads), more complexity (state between steps), for the benefit of isolation and independent scoring.

The recommendation-fit failure (cases 01 + 08) is a *chain* failure, not a single-step failure. The diagnosis names payment_failure correctly (`root_cause_plausibility` pass rate 75%); the recommendation agent then proposes "pause the A/B experiment" instead of "escalate to payments." That's a step 2 problem the chain isolation lets you see cleanly — it wouldn't be visible in a monolithic prompt.

Related: **../05-evals-and-observability/02-eval-methods.md** (how the chain-per-step gets scored independently). **../04-agents-and-tool-use/01-agents-vs-chains.md** (chains vs agents — this codebase uses both: a chain of two agents).

## Project exercises

### B2.3 · Add a "verify" step to the chain

- **Exercise ID:** B2.3
- **What to build:** Insert a third step between diagnosis and recommendation: a cheap-model check that asks "does the diagnosis's primary root cause match what the recommendation is addressing?" If no, either regenerate the recommendation with an explicit note, or emit a warning event to the UI.
- **Why it earns its place:** Directly targets the case-01+case-08 recommendation-fit failure. Interview payoff: "the eval showed a real failure; here's the chain-shaped fix I designed."
- **Files to touch:** New `lib/agents/verify.ts` (Haiku-model verifier), `app/api/agent/route.ts` (insert between steps), new `eval/rubrics/chain-coherence.ts` (score the added step separately).
- **Done when:** the verifier runs on all 10 baseline cases; when it flags a mismatch, either the rec is regenerated or a `chain_warning` NDJSON event fires; new receipt fields capture the verifier's decision.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why not have one agent do both steps?**

Three reasons. (1) You can't score them separately — the eval's diagnosis rubric and recommendation rubric are different dimensions; a single output would need a merged rubric. (2) You can't cache the diagnosis independently — a re-render of the recommendation page would re-run everything. (3) You can't swap models per step — diagnosis needs Sonnet's reasoning, recommendation might work on Haiku. Load-bearing: the chain gives you three independent knobs at the cost of one extra API round-trip.

**Q: The chain is where the eval failures live. Doesn't that argue against chaining?**

No — the eval failures live at the *seam* between the two steps. That's exactly where chaining gains you visibility. A monolithic prompt with the same failure would look like "the answer was wrong" with no way to say why. The chain lets you point at "step 1 got the root cause right; step 2 misconnected the action to the cause." That's the diagnostic power, not the failure signature.

## See also

- [../04-agents-and-tool-use/01-agents-vs-chains.md](../04-agents-and-tool-use/01-agents-vs-chains.md) — chains of agents vs single agents.
- [../05-evals-and-observability/02-eval-methods.md](../05-evals-and-observability/02-eval-methods.md) — how the chain is scored per step.
- [01-context-window.md](01-context-window.md) — the fixed prefix each step of the chain rebuilds.
