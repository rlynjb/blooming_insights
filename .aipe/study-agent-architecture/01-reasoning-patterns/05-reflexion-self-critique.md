# Reflexion / self-critique loop

*Industry names: Reflexion / self-critique · Language-agnostic*

## Zoom out

```
  Zoom out — reflexion wraps any base pattern with a critic

  ┌─ agent loop skeleton ────────────────────────┐
  │  step + execute + accumulate + terminate     │
  └─────────────────┬────────────────────────────┘
                    ▼
  ┌─ base pattern (ReAct here) ──────────────────┐
  │  produces draft output                        │
  └─────────────────┬────────────────────────────┘
                    ▼
  ┌─ ★ REFLEXION LOOP (critic on top) ★ ─────────┐ ← we are here
  │  critic evaluates → revise or accept          │
  └──────────────────────────────────────────────┘
```

## Zoom in

The agent evaluates its own output and retries if it's wrong. It's not a new base pattern — it's a wrapper around any base pattern (ReAct, plan-and-execute) that adds a critic step. The tradeoff is roughly 2-5x tokens for one reliability step. Not currently used in this repo; the eval story here is offline (LLM-as-judge against frozen trajectories), not in-request.

## Structure pass

Layers: **producer** (base pattern) — **critic** (evaluates producer's output) — **revision harness** (bounds the retries).

Axis to hold constant: **is the critic seeing what the producer missed?**

That's the whole load-bearing question. A critic from the same model family shares the producer's blind spots. Reflexion's mitigation options are (a) different model family (b) different prompt structure (c) grounded scoring against a rubric or ground truth.

## How it works

### Move 1 — the shape

You've written a React component with a `try / catch / retry` around a mutation before. Reflexion is that shape where the "try" is a full agent run, "catch" is the critic saying "this is wrong because …," and "retry" is the agent running again with the critic's note prepended to context.

```
  Reflexion — critic loop on top of a base pattern

  ┌──────────────────────────────────────────────┐
  │  base pattern (ReAct) → draft output          │
  └────────────────────┬─────────────────────────┘
                       ▼
  ┌──────────────────────────────────────────────┐
  │  Critic step: "is this correct / complete?"   │
  └──────────┬──────────────────────┬────────────┘
             ▼ good                 ▼ flawed
         return                revise + loop
                               (cap retries)
```

### Move 2 — the mechanics, and where it would fit here

**How the critic gets built.** Two shapes: **inline critic** (the same agent runs a second turn asking itself "is my draft answer good?") and **separate critic agent** (a second agent with its own prompt, tools, and possibly different model). The inline shape is one extra model call; the separate shape is a two-agent mini-topology — a bridge into SECTION C debate/verifier patterns (see `03-multi-agent-orchestration/05-debate-verifier-critic.md`).

**The hard limit.** A model critiquing its own output shares the blind spots that produced the output. Self-critique catches format and obvious-error failures well (a Diagnosis with an empty `evidence` array); it catches subtle-reasoning failures poorly. When the stakes justify it, use a different model family for the critic — the same self-preference bias applies (`.aipe/study-ai-engineering/07-evals/03-llm-as-judge.md`).

**Cost math.** One extra reliability step ≈ +50-100% tokens on average (draft + critique; occasional revisions add more). For a $0.09 diagnostic case, reflexion would push per-case cost to ~$0.15-0.18. That's real budget — the question is whether it buys enough quality to matter.

**Where it would fit in this repo — not yet implemented.** The natural spot is between diagnostic and recommendation. Today, the pipeline is:

```
  Today: no critic

  Diagnostic → Diagnosis (JSON) → Recommendation
```

With reflexion added:

```
  With critic

  Diagnostic → Diagnosis (draft)
                    │
                    ▼
              ┌───────────────┐
              │ DiagnosisCritic│  scores conclusion + evidence
              └───────┬────────┘  against a rubric
              approved / needs revision
                    │
     ┌──────────────┴──────────────┐
     ▼ approved                    ▼ needs revision
  Recommendation             Diagnostic (with critic note
                             prepended to context)
                             — cap at 2 revisions
```

New file: `lib/agents/diagnosis-critic.ts`. Wiring: `app/api/agent/route.ts` between the diagnostic and recommendation calls, guarded by a `?critic=1` flag while measuring. The eval baseline (runId `2026-07-03T04-08-28-644Z`, r-judge p50 90s, d-judge p50 38s) gives the "yes this would improve" bar to beat — if the online critic doesn't measurably lift diag-judge scores, ship without it.

**The termination guard.** Reflexion loops need the same discipline as the base agent loop's budget exit: cap the retries (3 is common), and count each critic pass against the same `BudgetTracker` so a reflexion cycle can't blow the ceiling silently. Otherwise a stubborn critic can loop indefinitely.

### Move 3 — the principle

Adding a critic is the cheapest quality-improvement lever you have short of a better model — but only when the critic sees blind spots the producer misses. If they share a model family and prompt style, you're paying 2x tokens for a rubber stamp. Ground the critic against a rubric, external check, or different model family; otherwise skip it.

## Primary diagram

```
  Reflexion — the full loop with the guards

  ┌─ Base pattern (ReAct, plan-and-execute, …) ───┐
  │  input → draft output                          │
  └────────────────────┬──────────────────────────┘
                       │ draft
                       ▼
  ┌─ Critic step ──────────────────────────────────┐
  │  score against rubric OR ground truth          │
  │  emit { approved: bool, note: string }         │
  └──────────┬──────────────────────┬──────────────┘
             ▼ approved              ▼ needs revision
        return output           ┌──────────────────┐
                                │ retries < CAP?   │
                                └───┬──────────┬───┘
                                    ▼ yes      ▼ no
                            re-run base    return best
                            with critic     draft with
                            note added      warning
```

## Elaborate

Reflexion was named by Shinn et al. (Northeastern / MIT, Mar 2023). The original paper framed it as verbal reinforcement — the critic's feedback becomes a "self-reflection" persisted in memory across trials. The pattern predates the paper (chain-of-verification, self-consistency, etc. are close cousins) but Reflexion made the "critic loops back into the same agent's context" pattern legible.

Every current framework has some flavor: LangGraph's `AddMemorySaver` around a supervisor node, aptkit doesn't ship a critic primitive today (you'd build it in the wrapper), OpenAI Assistants have a similar hook via structured "reasoning" outputs. The name to remember is **verifier-critic** for the multi-agent variant — see `03-multi-agent-orchestration/05-debate-verifier-critic.md`.

## Interview defense

**Q: Do you have a critic in the loop?**

Not in-request. The critic runs offline against frozen trajectories — LLM-as-judge with a rubric. The reason is cost + latency: adding an inline critic would push per-case cost from ~$0.09 to ~$0.15 and add another ~40s p50 latency. My current diag-judge / rec-judge scores pass the bar; adding online reflexion isn't warranted yet.

Where I'd add it: between diagnostic and recommendation, with a hard cap of 2 revisions and the same BudgetTracker guarding the retries. If the diagnostic's confidence signal drifted, that's the file I'd write next (`lib/agents/diagnosis-critic.ts`).

*Anchor visual:* the reflexion-with-guards diagram above.

**Q: What's the failure mode of self-critique?**

Same-family blind spot. The critic and producer share biases if they're the same model with a similar prompt style. The mitigation is to (a) use a different model family for the critic, or (b) ground it against a rubric or external check. Otherwise you're paying 2x tokens for a rubber stamp.

## See also

- **`03-react.md`** — the base pattern reflexion would wrap in this repo.
- **`03-multi-agent-orchestration/05-debate-verifier-critic.md`** — the multi-agent variant of this pattern.
- **`04-agent-infrastructure/04-agent-evaluation.md`** — where the offline critic actually lives today.
- **`.aipe/study-prompt-engineering/`** self-critique concept — prompt-level mechanics.
