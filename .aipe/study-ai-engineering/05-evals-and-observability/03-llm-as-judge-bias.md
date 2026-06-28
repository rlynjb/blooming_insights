# 03 — LLM-as-judge bias

**Subtitle:** Position / verbosity / self-preference biases · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** When you use an LLM to score another LLM's outputs, three
biases reliably show up. Knowing them lets you design around them.

```
  Zoom out — biases live inside the judge

  ┌─ Eval harness ─────────────────────────────────────┐
  │  for each (input, golden) in eval set:             │
  │    agent_output = agent(input)                     │
  │    score = judge(input, golden, agent_output)      │  ← we are here
  │           ↑ THIS is where bias enters              │   (Case B)
  └────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — bias source.** Each bias comes from a
    different mechanism: position bias from attention, verbosity bias
    from training reward, self-preference from in-family fluency.
    Different mitigations per source.

## How it works

### Move 1 — the mental model

```
  Three known biases

  ┌─ Position bias ───────────────────────────────┐
  │  Judge prefers whichever variant appears      │
  │  first (or last) in the prompt.               │
  │  Fix: randomize order per eval; aggregate     │
  │  across orderings.                            │
  └────────────────────────────────────────────────┘

  ┌─ Verbosity bias ──────────────────────────────┐
  │  Judge prefers longer responses, even when    │
  │  longer doesn't mean better.                  │
  │  Fix: cap length OR include length as a       │
  │  scored dimension (penalize verbosity).       │
  └────────────────────────────────────────────────┘

  ┌─ Self-preference bias ────────────────────────┐
  │  Judge prefers outputs from the same model    │
  │  family as itself (Claude judges Claude       │
  │  favorably).                                  │
  │  Fix: use a different model family for judge  │
  │  than for the agent being judged.             │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' hypothetical evals, the mitigation set is:**

  → **Position bias mitigation.** For absolute scoring (one output at
    a time), position isn't an issue. For pairwise comparisons (which
    *could* land if the team A/B tests prompts), shuffle the order of
    A and B per eval item, OR run both orderings and average. The
    canonical pattern:

    ```typescript
    // Hypothetical test/evals/pairwise.ts
    async function pairwiseScore(input, outputA, outputB) {
      const scoreAB = await judge(input, outputA, outputB);  // A first
      const scoreBA = await judge(input, outputB, outputA);  // B first
      return (scoreAB + (1 - scoreBA)) / 2;  // averaged, position-debiased
    }
    ```

  → **Verbosity bias mitigation.** Anthropic-side: the diagnostic
    agent's output is already structured JSON with bounded prose
    fields. The `conclusion` field is one sentence; `evidence` is a
    list of strings. The agent doesn't have headroom to be verbose.
    Judge-side: the rubric explicitly says "score based on accuracy
    and specificity, not length."

  → **Self-preference bias mitigation.** Use a different model family
    for the judge. blooming insights uses `claude-sonnet-4-6` for
    agents; the judge should be a non-Anthropic model — GPT-4o,
    `gemini-2.5-pro`, Llama 3.1 70B. The eval harness exercise from
    `01-eval-set-types.md` already specifies this.

**A subtler bias not in the canonical list: rubric drift.** If the
rubric's wording changes between eval runs, scores aren't comparable.
Pin the rubric prompt to git; treat the rubric file
(`test/evals/judge-prompt.ts`) as the source of truth, version it,
note rubric changes in CHANGELOG.

**Another subtle one: input-shaped bias.** The judge sees the input
along with the output, and can be biased by hints in the input. For
example, if a golden-set anomaly is labeled "critical" and the judge
sees that, it might score outputs that match "critical" higher than
outputs that match the actual cause. Mitigation: separate "context for
the judge to understand the input" from "context the judge should be
blind to" — pass only what's needed.

**Calibration check.** Once in a while (monthly?), have a human re-
score 5-10 items from a recent eval and compare to the LLM judge.
If LLM-judge scores correlate >0.7 with human scores, the judge is
reliable. If <0.5, the rubric needs work or the judge model needs
swapping.

### Move 3 — the principle

**LLM-as-judge is biased; biased scoring is still useful for *relative*
tracking ("did this PR regress?") but not for *absolute* claims ("our
agent is 92% accurate").** Design the eval for relative use, mitigate
known biases, calibrate against human scoring periodically.

## Primary diagram

```
  The three biases and their mitigations

  ┌─ POSITION BIAS ───────────────────────────────┐
  │  source: attention weights favor edges        │
  │  affects: pairwise comparisons primarily      │
  │  fix: randomize / run both orderings / avg    │
  └────────────────────────────────────────────────┘

  ┌─ VERBOSITY BIAS ──────────────────────────────┐
  │  source: training rewards detailed responses  │
  │  affects: absolute and pairwise               │
  │  fix: cap length in prompt OR penalize length │
  │   in rubric                                    │
  └────────────────────────────────────────────────┘

  ┌─ SELF-PREFERENCE BIAS ────────────────────────┐
  │  source: in-family fluency / familiar phrasing│
  │  affects: any cross-model evaluation           │
  │  fix: use different model family for judge    │
  │   (GPT-4o judges Claude; Claude judges GPT)   │
  └────────────────────────────────────────────────┘

  PLUS: rubric drift (pin to git), input bias (limit context to judge)
```

## Elaborate

The three biases were first cataloged in "Judging LLM-as-a-Judge with
MT-Bench and Chatbot Arena" (Zheng et al., 2023). The paper showed
that GPT-4-as-judge had measurable position bias (~5-10 pp shift based
on order), verbosity bias (~10-15 pp preference for longer responses),
and self-preference (GPT-4 favored GPT-4 outputs by ~5 pp over
equivalently good outputs from other models).

Subsequent work has shown these biases are mitigatable but not
eliminatable. The mainstream production practice: use LLM-as-judge for
relative tracking, calibrate against humans periodically, treat
absolute scores as approximate.

For blooming insights specifically: the most important mitigation is
*using a non-Anthropic judge for Anthropic-produced outputs*. Without
this, the judge will systematically inflate scores. GPT-4o or
Gemini-2.5-Pro are the standard choices; both have strong rubric-eval
performance.

## Project exercises

### Exercise — calibration check between LLM judge and human

  → **Exercise ID:** `study-ai-eng-05-03.1`
  → **What to build:** After the LLM-as-judge from `02-eval-methods.md`
    exercise is running, hand-score 5-10 recent eval items yourself.
    Compute the correlation (Pearson or Spearman) between LLM-judge
    scores and your human scores. Document the result in the eval
    README; if correlation < 0.5, iterate on the rubric.
  → **Why it earns its place:** "How do you know your LLM judge is
    reliable?" is the second-question follow-up in any eval interview.
    Calibration is the answer; without it the claim is theoretical.
  → **Files to touch:** new `test/evals/calibration.md` (note pad +
    correlation result), no code changes.
  → **Done when:** Correlation number is documented; iteration on
    rubric or judge model captured.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: What biases would your LLM-as-judge eval be subject to?**

Three canonical ones plus subtler ones:

```
  position bias     — pairwise comparisons; fix by randomize+average
  verbosity bias    — judge prefers longer; fix by length cap or rubric
  self-preference   — Claude favors Claude; fix by non-Anthropic judge

  + rubric drift    — pin rubric to git
  + input bias      — limit context the judge sees
```

For blooming insights specifically, the biggest one is self-preference
— since the agents are Claude, the judge should be non-Anthropic
(GPT-4o is the canonical choice). The harness exercise from
`01-eval-set-types.md` already specifies this.

**Anchor line:** "Judge model from different family than agent. Without
this single move, scores systematically inflate."

**Q: How do you know your LLM judge is reliable?**

Calibrate against human scoring periodically. Hand-score 5-10 recent
eval items, compute correlation with the LLM judge. Aim for >0.7
correlation. If <0.5, iterate on the rubric or swap judge models.
Treat LLM-as-judge scores as approximate; don't make absolute
claims like "92% accurate" from them.

## See also

  → `02-eval-methods.md` — when LLM-as-judge is the right method
  → `01-eval-set-types.md` — the eval sets the judge scores against
