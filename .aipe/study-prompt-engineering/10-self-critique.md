# 10 — Self-critique and self-consistency

*Output-quality bootstrapping · Industry standard · Case B (not used in this codebase)*

## Zoom out, then zoom in

Self-critique would live as a *second* pass over a chain's output, before the structured Diagnosis or Recommendation reaches the consumer.

```
  Where self-critique WOULD live (it doesn't, in this codebase today)

  ┌─ Agent loop (current) ───────────────────────────────────────────┐
  │  ┌─ tool loop (concept 06) ──┐    ┌─ structured output (02) ─┐    │
  │  │  hypotheses + queries      │ →  │ Diagnosis + type guard   │ →  │ UI
  │  │  conclude in N turns       │    │ FALLBACK on parse fail   │    │
  │  └────────────────────────────┘    └──────────────────────────┘    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ Agent loop (with self-critique inserted) ───────────────────────┐
  │  ┌─ tool loop ──┐    ┌─ ★ critique pass ★ ──┐    ┌─ revised  ─┐ │ ← we are here
  │  │  same        │ →  │  "Score your own      │ →  │ Diagnosis │ │
  │  │              │    │   answer 1–5; what's   │    │ + type    │ │
  │  │              │    │   weak about it?"      │    │ guard     │ │
  │  └──────────────┘    └────────────────────────┘    └───────────┘ │
  └────────────────────────────────────────────────────────────────────┘
```

This file is **Case B**: the pattern is real and widely used in production for high-stakes outputs; this codebase doesn't use it today. The honest framing matters — self-critique costs 2–5x in tokens for one extra reliability step, and for the outputs this codebase produces (anomalies, diagnoses, recommendations rendered as UI cards), the cost/benefit hasn't landed on "yes." Two places it would land on yes are named in Project Exercises below.

## Structure pass

**Layers.** Outer: the original output. Middle: the critique pass. Innermost: the revised output.

**Axis — what does the second pass add?** Walk it down:

```
  one axis — "what does the second pass add?" — three answers

  ┌─ self-critique ────────────────────────┐
  │  ADDS: targeted revisions to weak parts │  2x tokens, 1 extra call
  └────────────────────────────────────────┘
       ┌─ self-consistency ────────────────┐
       │  ADDS: voting across N runs        │  N x tokens, N calls
       └────────────────────────────────────┘
            ┌─ LLM-as-judge in eval ────────┐
            │  ADDS: per-output scoring      │  used at eval time, not runtime
            │  for the eval set              │  (concept 05)
            └────────────────────────────────┘
```

**Seams.** Two seams matter. Output-to-critique is the seam where you decide *what to critique* — the full output, or specific fields. Critique-to-revision is where the model has to decide if its first answer was good enough. The second seam is where the diminishing-returns problem hides.

## How it works

### Move 1 — the mental model

You know how a good code reviewer doesn't just rubber-stamp your PR — they read it back to you, find the weak part, ask the question that exposes the bug? Self-critique is asking the model to be its own code reviewer. Self-consistency is the same idea but quorum-based — run the model N times and vote.

```
  Pattern — self-critique, the kernel

       ┌─ original answer ─┐
       │  Diagnosis v1      │
       └─────────┬─────────┘
                 │
                 ▼
       ┌─ critique pass ───┐
       │  "Read your answer │  ← second LLM call, same model
       │   above. Score it  │     fresh context, sees only v1
       │   1-5. Name the    │     plus the rubric
       │   weakest part."   │
       └─────────┬─────────┘
                 │
                 ▼
       ┌─ revise (or keep) ┐
       │  Diagnosis v2      │  ← either the original (if critique
       └────────────────────┘     said it was fine) or a revision
                                  targeting the weak part
```

The mechanism: a fresh-context second pass catches some of the issues the first pass missed. Not all of them — the *same model* has the *same blind spots*. But for issues the first pass *would* have caught with more attention, the second pass often does.

### Move 2 — the walkthrough

**Self-critique, step by step.** Pseudocode:

```
  # self-critique loop, conceptual

  # 1. run the chain normally
  answer_v1 = await chain.run(input)

  # 2. score it with a rubric
  critique = await llm.complete({
    system: "Score the following answer 1-5 against this rubric: ...",
    user: f"Answer: {answer_v1}\nRubric: [cites evidence, ...]"
  })

  # 3. revise if the score is below threshold
  if critique.score < 4:
    answer_v2 = await llm.complete({
      system: "Revise the answer based on the critique below.",
      user: f"Original: {answer_v1}\nCritique: {critique.feedback}"
    })
    return answer_v2
  return answer_v1
```

Three calls total. The original chain (could itself be a multi-turn tool loop). The critique. The optional revision. **2–3x token cost** for one extra reliability step.

**Self-consistency, step by step.** Different pattern, same goal:

```
  # self-consistency, conceptual

  # 1. run the chain N times with the same input
  candidates = await Promise.all([
    chain.run(input),
    chain.run(input),
    chain.run(input),
    chain.run(input),
    chain.run(input),  # N = 5
  ])

  # 2. vote — pick the most common answer
  return mode(candidates)
```

N calls total. Higher latency, higher cost, but works well for classifier outputs where "the right answer" is well-defined and stable across runs. **N x token cost.**

**Step 3 — when the extra cost is worth it.** Three situations:

  → **High-stakes outputs.** An email the system is about to send. A summary that goes to a customer. A diagnosis a marketer will act on. Any output where being wrong has a real cost.
  → **Low-trust classifiers.** Sentiment analysis on customer feedback when the downstream action is "auto-escalate to support." Self-consistency (vote across N runs) is exactly the shape that fits here.
  → **Content that's hard to manually review.** When the output is long-form or there are many of them, you can't have a human review every one. Self-critique provides a synthetic second pair of eyes.

**Step 4 — the diminishing returns problem.** This is the critical caveat. A model critiquing its own output has the *same blind spots* that produced the output in the first place. If the model has a systematic bias (over-confident in factually-wrong claims, say), self-critique will sometimes reinforce the bias instead of catching it.

```
  Pattern — the blind-spot problem

  ┌─ model's blind spot: ──────────────────────────────┐
  │  consistently scores ambiguous causal claims as     │
  │  "high confidence" even when evidence is thin       │
  └───────────────────────┬────────────────────────────┘
                          │
                          ▼
  ┌─ answer v1 ─────────────────────────────────────────┐
  │  "High confidence: revenue dropped due to mobile     │
  │   regression." (evidence actually thin)              │
  └───────────────────────┬─────────────────────────────┘
                          │
                          ▼
  ┌─ self-critique pass ────────────────────────────────┐
  │  "Score the answer 1-5 for evidence-strength."       │
  │  → "4/5 — the answer is well-supported."             │
  │     ↑ SAME BLIND SPOT, MISSED THE BUG               │
  └─────────────────────────────────────────────────────┘
```

Mitigations:

  → **Rotate models.** Critique with a different model (Sonnet output critiqued by Opus, Haiku output critiqued by Sonnet). Different training data → different blind spots.
  → **Critique with a specific rubric, not "is this good?"** Forcing the model to score against a *checklist* — "does it cite a specific number? does it name the segment? does it explain the causal link?" — limits how much the model can rubber-stamp itself.
  → **Spot-check with humans.** Self-critique replaces human review at scale; it doesn't *replace* it entirely. The eval set (concept 05) is where you measure how well the critique tracks human judgment.

**Step 5 — what this codebase does instead.** It's worth being honest about why self-critique isn't in this codebase. Three reasons:

  → **The outputs are surfaced to the user with provenance.** Every Anomaly card shows the metric and the change %. Every Diagnosis shows the conclusion AND the evidence. Every Recommendation shows the rationale AND the assumption. The user *is* the review pass — they see the work and can override it.
  → **The forced-final synthesis turn is a poor man's self-critique.** When the diagnostic loop exhausts its budget, the recovery prompt at `lib/agents/diagnostic-legacy.ts:79-101` hands the model its own evidence back and asks for a structured answer. That's not self-critique, but it's adjacent — the model gets one more pass to clean up its output.
  → **The eval set hasn't shown a need.** Concept 05 names that there *is* no eval set, so this argument is weaker than it sounds. The honest version: without an eval set, I haven't *measured* a need for self-critique. The next eval set would be the place to test whether self-critique on the recommendation agent's rationale field would lift quality enough to justify the token cost.

**Where it WOULD make sense in this codebase.** Two places I'd reach for it:

  → **Recommendation agent rationale field.** This is the field most exposed to the user, and the field where the model is most likely to write a confidently-wrong "this will recover $X" claim. A self-critique pass against a rubric (cites a number, names the segment, explains the link) would catch hand-waved rationales.
  → **High-confidence diagnoses on thin evidence.** The diagnosis confidence is derived deterministically (`diagnosisConfidence` in `lib/insights/derive.ts`) — but a self-critique pass could be a sanity check on the *content* of `conclusion` when confidence is high. "You said this with high confidence; cite the specific numbers that warrant that confidence."

### Move 3 — the principle

A second pass over your own work catches a fraction of the errors the first pass missed — bounded by the model's blind spots. Self-critique is the cheap shape; self-consistency is the parallel shape; LLM-as-judge in evals is the offline shape. All three trade tokens for reliability. The discipline: don't add them preemptively, add them when you measure the cost/benefit lands favorably for *this specific output*.

## Primary diagram — self-critique vs self-consistency vs eval-judge

```
  THREE FLAVORS OF "LLM CHECKING LLM OUTPUT"
  ──────────────────────────────────────────

  ┌─ self-critique (runtime, 1 extra call) ──────────────────────────┐
  │  chain output v1  →  critique pass  →  revise (or keep) v2        │
  │  cost: 2-3x tokens                                                  │
  │  fixes: targeted weak spots in the answer                            │
  │  catches NOTHING in the model's blind spots                          │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ self-consistency (runtime, N parallel calls) ───────────────────┐
  │  run N times → vote → pick the mode                                │
  │  cost: N x tokens (cheaper if you can run in parallel)              │
  │  fixes: stochastic variance in classifier outputs                    │
  │  works ONLY when there's a "right answer" that's stable               │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ LLM-as-judge in evals (offline, concept 05) ─────────────────────┐
  │  golden case + chain output → judge scores against rubric           │
  │  cost: one extra call per eval case                                 │
  │  fixes: catches regressions in the eval CI loop                       │
  │  same blind-spot problem; rotate judge model + human spot-check 10% │
  └─────────────────────────────────────────────────────────────────────┘

  this codebase uses NONE of these today. Closest thing: the forced-final
  synthesis turn (lib/agents/base-legacy.ts:239-270 + diagnostic-legacy.ts:
  79-101) which is more "recovery" than "critique" — same model, fresh
  prompt, structured-output forcing function.
```

## Elaborate

The self-consistency paper (Wang et al., 2022) is the canonical reference for the voting flavor. The mechanism is robust on math word problems and other tasks with a clear right answer; less robust on open-ended generation where the "vote" has to be on something fuzzier than a single integer answer.

Self-critique as a runtime pattern doesn't have a single canonical paper because it's mostly engineering folklore — every production AI engineer has tried it on something. The honest summary: it lifts quality more reliably than self-consistency on open-ended outputs, costs less, and has the blind-spot problem more sharply.

Three places to deepen:

- **Anthropic's research on "Constitutional AI" (Bai et al., 2022).** Self-critique applied to safety, with a constitution (set of principles) as the rubric. Different goal from quality improvement; same mechanism.
- **OpenAI's "Process supervision" work.** Critique the reasoning steps, not just the answer. A more nuanced version of self-critique that catches *process* errors rather than *output* errors.
- **The "weak-to-strong generalization" literature.** When a weaker model critiques a stronger model's output, does it help? Mostly no, but the failure modes are educational — the weak critic over-flags surface issues and misses substantive ones.

In this codebase, concept 05 (eval-driven iteration) is the *offline* version of the same LLM-as-judge mechanism — the difference is when it runs (CI vs runtime) and what triggers the revision (a failing eval case vs a low critique score). Concept 09 (chain-of-thought) is the *intra-call* version — reasoning through the problem before answering, vs reasoning about the answer after producing it.

## Project exercises

### Exercise — Add self-critique to the recommendation agent's rationale field

  → **Exercise ID:** SELFCRIT-RECCO-RATIONALE
  → **What to build:** After `RecommendationAgent.propose()` produces its `Recommendation[]`, run a second LLM call that scores each `rationale` against a rubric (cites a specific number from the diagnosis, names the affected customer segment, explains the causal link from diagnosis to action, is actionable for a marketer). Recommendations with a rationale scoring <4/5 get a revision pass.
  → **Why it earns its place:** The rationale field is the most exposed to the user and the most likely to drift into hand-waved language. The cost (2x recommendation tokens — small, since recommendations are short) is bounded. Concept 05's eval substrate doesn't exist yet, so the *measurement* of whether this helps lives on the same to-do list.
  → **Files to touch:** `lib/agents/recommendation.ts` (or `recommendation-legacy.ts`), add a `critiqueRationale()` helper, optionally a new prompt at `lib/agents/legacy-prompts/critique-rationale.md`.
  → **Done when:** the recommendation flow returns rationales that all score ≥4 on the rubric in a 10-case test; the trace shows the critique pass running for any below-threshold rationale.
  → **Estimated effort:** ~3–4 hours including the rubric.

### Exercise — Add self-consistency to the intent classifier

  → **Exercise ID:** SELFCONS-INTENT
  → **What to build:** Modify `classifyIntent()` in `lib/agents/intent.ts` to optionally run N=3 calls in parallel and return the mode (or a low-confidence fallback if N=3 disagrees). Gate the behavior behind a `selfConsistent: boolean` parameter so the default stays single-shot.
  → **Why it earns its place:** Intent classification is exactly the self-consistency shape — a small valid range (three values), well-defined "right answer," cheap model (Haiku 4.5). Voting across 3 Haiku calls is faster than running the wrong downstream agent and recovering.
  → **Files to touch:** `lib/agents/intent.ts` (or `intent-legacy.ts`); a small unit test that verifies the vote logic.
  → **Done when:** with `selfConsistent: true`, the classifier runs 3 Haiku calls in parallel and returns the majority intent (or `'diagnostic'` fallback on a 1-1-1 split, matching the existing default).
  → **Estimated effort:** ~2 hours including the test.

## Interview defense

**Q: "Do you use self-critique?"**

Not in this codebase today. *(Be direct.)* The outputs are all surfaced to the user with provenance — every Anomaly shows the change %, every Diagnosis shows the evidence, every Recommendation shows the rationale and assumption. The user IS the review pass. I haven't measured a quality gap that self-critique would close, but the honest version of that is: I don't have an eval set yet, so I haven't *measured* anything. The two places I'd reach for it are the recommendation agent's rationale field and high-confidence diagnoses on thin evidence — both are where the model is most likely to write confidently-wrong claims.

```
  where self-critique would land in this repo:
  ─ recommendation rationale (most user-exposed, most drift-prone)
  ─ high-confidence diagnosis on thin evidence (over-confident bias)
```

Anchor: *"don't add it preemptively. Add it when you measure the lift on a specific output."*

**Q: "What's the failure mode?"**

The blind-spot problem. *(Draw the diagram.)* A model critiquing its own output has the same blind spots that produced the output in the first place. If the model systematically over-confides in causal claims, self-critique will rubber-stamp the over-confident output instead of catching it. Three mitigations: rotate models (Sonnet output critiqued by Opus), use a specific rubric instead of "is this good?", spot-check with humans on a sample to verify the critique tracks human judgment.

```
  blind-spot mitigations:
  ─ rotate model for the critique pass
  ─ rubric (checklist), not "is this good?"
  ─ human spot-check on 10%
```

Anchor: *"the critic has the same blind spots as the producer. Same model, same biases. Rotate the model or you're rubber-stamping."*

**Q: "Self-critique vs self-consistency — when each?"**

Different shapes. *(Pull up the three-flavor diagram.)* Self-critique: one extra call, targeted revision of weak parts, works on open-ended outputs. Self-consistency: N parallel calls, vote on the answer, works only when there's a stable right answer (classifiers). For the intent classifier in this codebase, self-consistency fits — three Haiku calls in parallel, vote on the intent. For the recommendation rationale, self-critique fits — one extra Sonnet call against a rubric, revise if it scores low. Both share the same blind-spot caveat.

Anchor: *"self-critique for open-ended outputs; self-consistency for classifiers with a stable right answer."*

## See also

- `02-structured-outputs.md` — self-critique adds a step to the structured-output pipeline; the validator still runs at the end.
- `05-eval-driven-iteration.md` — the offline version of LLM-as-judge; runs in CI instead of at runtime.
- `09-chain-of-thought.md` — CoT is reasoning *through* the problem; self-critique is reasoning *about* the answer. Complementary, not redundant.
- `06-single-purpose-chains.md` — self-critique adds a small chain to an existing pipeline; the single-purpose discipline keeps the critique chain itself focused.
