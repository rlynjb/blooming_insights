# Coordination failure modes

*Industry name: multi-agent failure modes — Industry standard.*

The failures that don't exist in single-agent systems but show up the moment you have two or more. This repo's minimal-multi-agent shape *forbids* most of them by topology choice, but the cost-blowup and synthesis-failure cases still apply.

## Zoom out — which failures show up where

The applicability of each failure depends on the topology. This repo's deterministic sequential pipeline + code supervisor eliminates the orchestration-decision failures (infinite handoff, supervisor wandering) but not the cost/budget failures.

```
  Which failures apply to this repo

  ┌─ DO NOT APPLY (topology forbids) ─────────────────────┐
  │  Infinite handoff (A→B→A→B…)                          │
  │    — agents never hand off; route dispatches          │
  │  Supervisor wandering / wrong-worker dispatch          │
  │    — supervisor is code; `if (step === X)` can't wander│
  │  Context bloat from shared blackboard                  │
  │    — no blackboard (message passing forced by Vercel) │
  └────────────────────────────────────────────────────────┘

  ┌─ DO APPLY ─────────────────────────────────────────────┐
  │  Tool-call cascade (one agent triggers a storm)        │ ← see below
  │  Cost blowup (2-5x overhead compounds silently)        │ ← see below
  │  Synthesis failure (supervisor merges contradictions)  │ ← see below
  │     (route handler synthesizes by passing through;     │
  │      contradiction = inconsistent agent outputs)       │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what mitigation lives at what layer?**

```
  Failure                  Mitigation in this repo                Where it lives
  ─────────                ──────────────────────                 ──────────────
  Tool-call cascade        maxToolCalls per agent (4 or 6)        kernel (AptKit)
  Cost blowup              maxTurns per agent (6 or 8)            kernel (AptKit)
  Synthesis failure        validators on each agent's output      AptKit per-agent
                           + structural prompt rules               prompts
```

## How it works

### Move 1 — the mental model

Multi-agent failure modes are *emergent* — they don't show up in unit tests where you test one agent in isolation. They show up when agents compose, and they manifest as cost blowups, infinite loops, or contradictory outputs. The mitigation pattern is always the same: bound the bad-case behavior at the lowest layer, so the failure surfaces fast and stops.

```
  Coordination failure modes — table of failures and mitigations

  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force   │
  │ (A→B→A→B…)            │ stop or escalate to human│
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent and global      │
  │ (one agent triggers  │ iteration caps; budget    │
  │ a storm of calls)    │ ceiling that halts the run│
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat as      │ Message passing / context │
  │ agents accumulate     │ routing instead of a       │
  │ shared state         │ shared blackboard          │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs    │
  │ (supervisor merges    │ against a schema before    │
  │ contradictory results│ synthesis; surface         │
  │ )                    │ conflicts, don't average   │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;      │
  │ (2-5x overhead       │ cheap models for workers,  │
  │ compounds silently)  │ expensive only for the     │
  │                      │ supervisor                 │
  └──────────────────────┴──────────────────────────┘
```

### Move 2 — failure by failure, with this repo's specifics

**Tool-call cascade.**

The classic failure: one agent retries a flaky tool every turn, burning the whole budget on a tool that isn't coming back. In a multi-agent system this compounds — if Worker A keeps retrying and that retry causes Worker B to retry its dependency, you get a cascade.

In this repo, the mitigation is at the kernel layer:
- `MonitoringAgent`: `maxToolCalls=6` (capped at AptKit's `AnomalyMonitoringAgent`)
- `DiagnosticAgent`: `maxToolCalls=6`
- `RecommendationAgent`: `maxToolCalls=4` (tighter — it mostly reasons from diagnosis)
- `QueryAgent`: `maxToolCalls=6`

The cap is enforced inside `runAgentLoop` — once hit, the synthesis turn fires regardless of what the model wants. **No agent in this repo can issue more than 6 tool calls per run** by topology guarantee. See `../01-reasoning-patterns/02-agent-loop-skeleton.md`.

What's *not* yet mitigated: per-tool circuit breaking (see `../05-production-serving/03-per-tool-circuit-breaking.md`). A flaky tool still wastes calls until the budget is spent; it doesn't get short-circuited.

**Cost blowup.**

Multi-agent overhead compounds silently. A 3-agent pipeline with 6 tool calls each = up to 18 LLM calls + 18 tool calls per investigation. Without per-agent budgets, that climbs to ~50 calls fast.

In this repo, the mitigation is per-agent budgets plus the bounded sequential structure (no fan-out). Total per-investigation budget worst-case:
- DiagnosticAgent: 8 turns × ~1 LLM call each + 6 tool calls = ~14 calls
- RecommendationAgent: 6 turns + 4 tool calls = ~10 calls
- Total: ~24 LLM calls + ~10 tool calls per investigation

Bounded and predictable. Cost blowup mitigated.

What's *not* yet mitigated: a per-run token-ceiling that halts the entire pipeline if the sum exceeds a threshold. Today the per-agent caps add up to a bounded total, but if a future change loosened any cap, there's no global guard.

**Synthesis failure.**

In a fan-out + merge topology, the synthesis step has to handle contradictory worker outputs — Worker A says "the drop is caused by mobile checkout"; Worker B says "the drop is caused by payment processor." Averaging is wrong; flagging the conflict is right.

In this repo, synthesis is degenerate — the route handler "synthesizes" by passing through. Each agent's output is the next agent's input directly; there's no merger to fail. **Synthesis failure is forbidden by topology.**

The case where it would re-appear: if MonitoringAgent ever fanned out (`04-parallel-fan-out.md`), the merger would need to handle "two categories detected the same anomaly with different severities" — the synthesis failure shows up at the merger boundary.

**Validators as the structural defense.**

Even without a synthesis step, each agent's output has to pass an AptKit-layer validator before it's surfaced — `tryParseAnomalies`, `tryParseDiagnosis`, `validateRecommendations`. These catch shape errors (missing fields, wrong types) before the next agent in the pipeline sees them. The validator is what turns "free-form text from a model" into "guaranteed-shape data the next agent can rely on."

### Move 3 — the principle

Multi-agent failure modes are emergent; mitigations belong at the lowest layer where the failure can be bounded. Per-agent budgets in the kernel; per-tool breakers at the data-source layer; validators at the agent-output boundary. The senior-engineer move is naming WHICH failure each mitigation prevents and WHAT topology change would re-expose the failure.

The minimal-multi-agent shape in this repo eliminates several failures by topology (handoff, supervisor wandering, context bloat). The remaining failures (cost, cascade) are bounded by the kernel's per-agent caps. The unaddressed failure (per-tool breaker) is the natural next investment when traffic justifies it.

## Primary diagram

The failure → mitigation → layer map for this repo:

```
  Coordination failure modes — what's mitigated where

  ┌─ AptKit kernel (per-agent budgets) ──────────────────────┐
  │  maxTurns + maxToolCalls + forced-final synthesis        │
  │  PREVENTS: tool-call cascade, infinite turn loop          │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ AptKit per-agent validator ──────────────────────────────┐
  │  tryParseAnomalies / tryParseDiagnosis / validateRecs     │
  │  PREVENTS: malformed handoff between agents               │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Route handler (topology) ────────────────────────────────┐
  │  sequential pipeline (no fan-out)                          │
  │  code supervisor (no LLM-decided dispatch)                 │
  │  message passing (no blackboard)                           │
  │  PREVENTS: handoff loops, supervisor wander, context bloat │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ DataSource adapter (BloomreachDataSource) ──────────────┐
  │  ~1 req/s spacing + retry on rate-limit + 60s cache       │
  │  PREVENTS: provider 429-storm                             │
  │  DOES NOT YET PREVENT: per-tool failure cascade           │ ← gap
  └───────────────────────────────────────────────────────────┘
```

## Interview defense

**Q: "What are the failure modes you'd worry about in a multi-agent system, and which apply to yours?"**

A: Five canonical failures. Three don't apply to this repo by topology choice: infinite handoff (no agent-to-agent handoff; route dispatches), supervisor wandering (supervisor is code; an `if` statement can't wander), context bloat from shared blackboard (no blackboard; message passing forced by Vercel's ephemeral instances). Two do apply: tool-call cascade and cost blowup — both bounded by per-agent budgets in the AptKit kernel (`maxToolCalls=4 or 6`, `maxTurns=6 or 8`, forced-final synthesis). One half-applies: synthesis failure — the route's "synthesis" is degenerate pass-through today, so contradictions can't arise; if we ever fanned out (`04-parallel-fan-out.md`), the synthesis step would need a real conflict-detection step.

The unaddressed gap: per-tool circuit breaking. A flaky tool today still wastes calls until the per-agent budget is spent. The fix is a per-tool breaker at the data-source layer (`../05-production-serving/03-per-tool-circuit-breaking.md`) that fails fast on a known-dead tool and feeds the open-circuit state back to the agent as an observation so the agent's reasoning routes around it.

Diagram I'd sketch:

```
  Topology-prevented:               Budget-bounded:
   - infinite handoff                - tool-call cascade
   - supervisor wander               - cost blowup
   - context bloat
                              Topology-degenerate (no merger):
                                - synthesis failure
                              Not yet mitigated:
                                - per-tool failure cascade
                                  (fix: circuit breaker)
```

Anchor: "the kernel's `maxToolCalls` is the single most load-bearing failure-bound. Without it, one flaky tool + an agent loop = the entire iteration budget spent on retries — the worst kind of cost blowup because it produces nothing."

**Q: "Where does the 2-5x multi-agent overhead show up in your numbers?"**

A: Worst-case investigation: DiagnosticAgent (8 turns × ~1 LLM call + 6 tool calls = ~14 calls) + RecommendationAgent (6 + 4 = ~10 calls) = ~24 LLM calls per investigation. Compared to a hypothetical single-agent "investigate and recommend in one loop" with a 12-call budget, that's ~2x the calls. The buy: each agent has a narrower prompt + tighter tool grant, so each call is cheaper than a do-everything single-agent's call. Net: probably ~1.5x cost for the specialization. Acceptable when the structure also gives us the human-in-the-loop pause between stages (the user reviews the diagnosis before recommendations are generated).

## See also

- [`../01-reasoning-patterns/02-agent-loop-skeleton.md`](../01-reasoning-patterns/02-agent-loop-skeleton.md) — where the budget exits live
- [`../05-production-serving/03-per-tool-circuit-breaking.md`](../05-production-serving/03-per-tool-circuit-breaking.md) — the unaddressed gap
- [`../05-production-serving/02-fan-out-backpressure.md`](../05-production-serving/02-fan-out-backpressure.md) — what synthesis failure would look like if topology changed
- [`../04-agent-infrastructure/05-guardrails-and-control.md`](../04-agent-infrastructure/05-guardrails-and-control.md) — the full control envelope around a loop
