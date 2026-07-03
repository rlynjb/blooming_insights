# Debate / verifier-critic

*Industry names: debate / verifier / critic / adversarial multi-agent · Language-agnostic*

## Zoom out

```
  Zoom out — the quality lever this repo runs offline only

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker (this repo)               │
  │  sequential pipeline                         │
  │  parallel fan-out                            │
  │  ★ debate / verifier-critic ★                │ ← we are here
  │  swarm / handoff                             │
  │  graph                                       │
  └──────────────────────────────────────────────┘
```

## Zoom in

Agents argue or critique to refine quality. Two flavors: **debate** (symmetric — two agents propose and counter) and **verifier-critic** (asymmetric — producer emits, critic scores/rejects). Not in-request in this repo; the eval story runs debate-adjacent (LLM-as-judge with a rubric) *offline* against frozen trajectories.

## Structure pass

Layers: **producer** — **critic (or opposing debater)** — **judge / arbiter** — **loop cap**.

Axis to hold constant: **does the critic see what the producer missed?**

Same load-bearing question as `01-reasoning-patterns/05-reflexion-self-critique.md`. If they share a model family and prompt style, you're paying 2x tokens for a rubber stamp. Ground the critic against a rubric, a different model family, or an external check.

## How it works

### Move 1 — the shape — two flavors

```
  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A  │◄─►│agent B  │         │ producer │──►│  critic  │
  │(propose)│   │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │  reject) │
       │            │                              └──────────┘
       └─────┬──────┘                   loop until approved
             ▼                          (cap the rounds)
        judge picks
```

The debate flavor is powerful for open-ended judgments (which answer is more helpful?); the verifier-critic flavor is powerful for correctness (is this factually right?). The repo's use case (evaluating diagnostic conclusions) is closer to verifier-critic — there's a right answer, not two equally-valid positions.

### Move 2 — how it's done here, offline

**Not in-request.** Adding an inline critic between diagnostic and recommendation would push per-case cost from ~$0.09 to ~$0.15 and add ~40s latency. My current diag-judge / rec-judge scores (baseline runId `2026-07-03T04-08-28-644Z`, d-judge p50 38s, r-judge p50 90s) pass the bar without it.

**Where the critic runs today.** In the eval harness — offline. The judge is an LLM-as-judge with a rubric, run against frozen trajectories from real (recorded) investigations. The pattern:

```
  Offline verifier-critic — how this repo actually critiques

  ┌─ recorded investigation (trajectory) ─────────────────┐
  │  Anomaly → Diagnostic ReAct trace → final Diagnosis   │
  │  Anomaly → Recommendation ReAct trace → Recs          │
  └───────────────────────┬───────────────────────────────┘
                          │ replayed offline
                          ▼
  ┌─ diagnostic-judge (LLM-as-judge) ─────────────────────┐
  │  input: Anomaly + Diagnosis                            │
  │  rubric: conclusion grounded? evidence cited?          │
  │          hypotheses actually considered?               │
  │  output: { score: 0-5, rationale }                     │
  └─────────────────────────────────────────────────────── │
  ┌─ recommendation-judge (LLM-as-judge) ─────────────────┐
  │  input: Diagnosis + Recommendations                    │
  │  rubric: proposals match diagnosis cause?              │
  │          feasible for this workspace?                  │
  │          expected impact plausible?                    │
  │  output: { score: 0-5, rationale }                     │
  └────────────────────────────────────────────────────────┘
```

The offline location is deliberate — cost and latency don't matter for offline eval (run once per regression check, not per user request), and the judge can use a bigger context / more careful prompt without user impact.

**Where inline debate would earn its cost.** If diag-judge scores drifted down after a prompt change and I couldn't see why. An inline critic between diagnostic and recommendation would give feedback the diagnostic could use immediately, at the cost of ~$0.06 and ~40s per case. The refactor is well-scoped (`lib/agents/diagnosis-critic.ts`, wire it into the route between the two agents, add a max-2-revisions cap), just not warranted yet.

**Debate vs verifier — when to pick which.** Debate is right when the "correct answer" isn't well-defined and multiple perspectives genuinely add signal (creative writing evaluation, ethical judgment). Verifier is right when there's a rubric-shaped answer and you're checking correctness. For analyst tasks, verifier is the correct pick.

**The failure mode — cross-family critique.** The most-common failure of any critic loop is when the critic and producer share a model family and prompt style. Both are Sonnet, both have similar training data, both share blind spots — so the critic rubber-stamps rather than catches. Mitigation: **use a different model family for high-stakes critics** (a Haiku critic on a Sonnet producer, or a GPT critic on a Claude producer), or ground the critic against an external rubric that doesn't rely on the critic's judgment.

The offline eval judges here are Sonnet judging Sonnet — same family. The rubric mitigates it partially (structured scoring rather than free judgment) but doesn't fully eliminate the correlation. Best next move if I hit correlated blind spots: swap the judges to a different model family.

### Move 3 — the principle

Debate and verifier-critic are quality levers with a real coordination tax. The producer-critic asymmetry is the more common and cheaper variant; symmetric debate is for genuinely open-ended judgments. Both need a loop cap (`3` rounds is common) and a shared budget so a stubborn critic can't drain the ceiling. The one production rule that matters most: use a **different model family** for the critic when the stakes justify it.

## Primary diagram

```
  Verifier-critic — the inline shape (not yet in this repo)

  ┌─ Producer agent ──────────────────────────────────────────┐
  │  runs base pattern (ReAct)                                │
  │  emits draft output (Diagnosis)                           │
  └────────────────────┬──────────────────────────────────────┘
                       │ draft
                       ▼
  ┌─ Critic agent ────────────────────────────────────────────┐
  │  different model family (recommended)                     │
  │  scores against rubric                                    │
  │  → { approved: bool, note: string, confidence: 0-1 }      │
  └──────────┬────────────────────────┬───────────────────────┘
             ▼ approved                ▼ needs revision
        return output                ┌──────────────────────┐
                                     │ retries < CAP (2-3)? │
                                     └───┬──────────────┬───┘
                                         ▼ yes          ▼ no
                                    re-run producer   return best
                                    with critic       draft with
                                    note prepended    warning
                                    (BudgetTracker
                                    also checks)
```

## Elaborate

Debate as a multi-agent pattern was popularized by AI Safety via Debate (Irving et al., OpenAI 2018) and later shown to improve factual answers in Multi-Agent Debate (Du et al., 2023) — two agents arguing over a question outperforms a single agent on multi-step reasoning benchmarks. The verifier-critic variant is older (adversarial training in GANs; test/debug loops in software engineering).

The "different model family" rule for critics comes from LLM-as-judge research (Zheng et al., 2023) — same-family judges show measurable self-preference bias. The mitigation of cross-family judging is now standard in benchmark leaderboards (MT-Bench, AlpacaEval).

## Interview defense

**Q: Do you have a critic in the loop?**

Not inline. The critic runs offline as LLM-as-judge with a rubric — diagnostic-judge and recommendation-judge in the eval harness. The reason it's offline: inline would cost ~$0.06 extra per case and add ~40s latency; my current d-judge / r-judge scores pass the bar without it. Where I'd add inline: if scores drifted and I couldn't debug why. The file would be `lib/agents/diagnosis-critic.ts`, wired into the route between diagnostic and recommendation with a max-2-revisions cap and shared budget check.

The one caveat: the offline judges are Sonnet judging Sonnet — same family, some correlated blind spot risk. The rubric mitigates it partially. Best next move if I hit correlated blind spots is swapping the judges to a different model family.

*Anchor visual:* the verifier-critic inline shape diagram above.

**Q: Debate vs verifier — which would you pick?**

Verifier for analyst tasks. There's a rubric-shaped right answer; debate would just add cost. Debate is right for open-ended judgments where multiple perspectives genuinely add signal (creative writing, ethical judgment). Not this product.

**Q: What's the failure mode of an inline critic?**

Correlated blind spots. Same model family, same prompt style, similar training data — the critic rubber-stamps rather than catches. Mitigation: different model family for the critic, or grounding against a rubric that doesn't rely on the critic's judgment. Otherwise you're paying 2x tokens for approval.

## See also

- **`01-reasoning-patterns/05-reflexion-self-critique.md`** — the single-agent version of this pattern.
- **`04-agent-infrastructure/04-agent-evaluation.md`** — where the offline judges actually live.
- **`.aipe/study-ai-engineering/07-evals/03-llm-as-judge.md`** — LLM-as-judge bias and mitigations.
