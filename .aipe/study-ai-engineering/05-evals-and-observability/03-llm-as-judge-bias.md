# LLM-as-judge bias

*Industry standard — position / verbosity / self-preference bias*

## Zoom out — where this concept lives

LLM-as-judge is cheap and scales (`02-eval-methods.md`), but it has known biases. The retired Phase 3 suite calibrated against these biases via an 8/8 + 3/3 manual spot-check before trusting the judge at scale. This file walks the three biases + the Phase 3 calibration pattern + what the next iteration would do differently.

```
  Zoom out — three biases to defend against

  ┌─ Position bias ─────────────────────────────────────────┐
  │  Judge prefers whichever variant appears first          │
  │  Defense: randomize order per evaluation                │
  └─────────────────────────────────────────────────────────┘
  ┌─ Verbosity bias ────────────────────────────────────────┐
  │  Judge prefers longer responses                         │
  │  Defense: cap length OR include length as a rubric item │
  └─────────────────────────────────────────────────────────┘
  ┌─ Self-preference bias ──────────────────────────────────┐
  │  Judge prefers outputs from the same model family       │
  │  Defense: use a different family as judge               │
  │  (Phase 3 used same family — known limitation)          │
  └─────────────────────────────────────────────────────────┘
  ┌─ ★ Calibration via manual spot-check ★ ─────────────────┐ ← we are here
  │  Phase 3 used 8/8 + 3/3 — manual review agreed on all   │
  │  Trust threshold met → run at scale                     │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The biases are real but not insurmountable — the calibration check is the load-bearing defense. Phase 3's 8/8 + 3/3 was the right shape; the next iteration should use a different judge family (Haiku judging Sonnet) to defend self-preference.

## Structure pass — layers · axes · seams

**Layers:** evaluator → judge → score.

**Axis: where does each bias originate / propagate / get caught?**
  → Position: in pairwise prompts; defended by randomization.
  → Verbosity: in any rubric where length isn't scored; defended by rubric design.
  → Self-preference: in the choice of judge model; defended by family swap.
  → Calibration drift: between the human spot-check and the at-scale run; defended by re-spot-checking on rubric changes.

**Seam:** the rubric prompt. That's where every bias defense lives — randomized order, length-as-rubric-item, judge model choice.

## How it works

### Move 1 — the mental model

You know how a human reviewer can have biases — preferring confident answers, longer essays, familiar phrasing — and a good review process compensates by structuring the rubric? Same shape. The LLM judge has known biases; the rubric design + calibration check is the structural compensation.

```
  Three known biases, three structural defenses

  bias                                defense
  ────                                ───────
  position (A vs B → prefers A)        randomize per-eval

  verbosity (long > short)             cap length OR rubric-score length

  self-preference (Sonnet rates        use different family as judge
   Sonnet output higher)                (Haiku judges Sonnet, GPT-4o
                                         judges Claude, etc.)

  → Plus: manual spot-check on N samples to catch any bias
          the rubric design missed.
```

### Move 2 — the step-by-step walkthrough

**Part 1 — position bias and the randomization defense.**

When the judge sees two variants ("Is response A better, or response B?"), it tends to prefer whichever appears first. Defense: randomize the order per evaluation. Half the time A appears first; half the time B does. Aggregate the scores by which-was-actually-A (using a hidden label), not by position.

Phase 3 didn't run pairwise eval (it scored each output independently against a rubric), so position bias wasn't a concern. The next iteration WILL include pairwise (prompt variant testing), and randomization needs to land there.

**Part 2 — verbosity bias and the rubric-design defense.**

The judge tends to prefer longer responses, treating "more words" as "more thoroughness." Two defenses:

  → **Cap length.** Tell the judge "ignore anything past 500 tokens." Crude but effective.
  → **Rubric-score length.** Include "is the response appropriately concise?" as a rubric dimension. The judge can't reward verbosity without explicitly losing points on the conciseness dimension.

The second is better-shaped: it makes length an explicit signal, not an implicit one. The Phase 3 recommendation rubric should have had a conciseness dimension; it didn't, which may have contributed to recommendations getting verbose over the eval iterations.

**Part 3 — self-preference and the family-swap defense.**

The Phase 3 suite used **Sonnet 4.6 as both agent and judge**. That's self-preference territory by construction — the judge has structural reasons to prefer outputs from its own family. The 8/8 + 3/3 manual spot-check provided some defense (the human caught any egregious bias), but the design was a known limitation.

The next iteration should use **Haiku as judge for the simpler rubric items** (especially the structured-output dimensions) and a different-family model where available. Haiku judging Sonnet is cross-family-enough (different model size, different training emphasis) to reduce self-preference, even if both are Anthropic.

**Part 4 — the calibration pattern in detail.**

Phase 3's 8/8 + 3/3 manual spot-check:

```
  Calibration shape

  1. Run the eval suite at scale.
  2. Random-sample N items (Phase 3: 8 diagnoses, 3 recommendations).
  3. Manually score each by a human reviewer.
  4. Compare LLM-judge scores to human scores.
  5. If agreement is high (Phase 3: 100% — 8 of 8, 3 of 3),
     trust the LLM-judge for the at-scale run.
  6. If agreement is low, debug the rubric: is the judge
     misreading some dimension? Is the rubric ambiguous?

  Re-spot-check whenever:
   - the rubric changes
   - the agent's prompt changes meaningfully
   - the underlying model is upgraded
```

The 8/8 + 3/3 numbers are small but defensible because Phase 3 was small (3 seeded anomalies, K=10). For a bigger eval (say 50 seeded anomalies, K=20), you'd want bigger spot-check samples (~10-20 each).

**Part 5 — what's NOT a bias but feels like one.**

Some "biases" people report on LLM-judges are actually rubric ambiguity, not judge bias. If the rubric says "is the conclusion well-reasoned?" without defining "well-reasoned," different judges (or the same judge on different runs) will score inconsistently. The defense is rubric precision, not bias mitigation. A good rubric is concrete: "does the conclusion name a specific cause? does it cite specific tool results? does it acknowledge alternative hypotheses?"

The Phase 3 rubric had this discipline; rubric ambiguity wasn't the bottleneck.

### Move 3 — the principle

**LLM-as-judge is cheap, biased, and defensible *with calibration*.** The biases are predictable (position, verbosity, self-preference) and have structural defenses (randomization, rubric design, family swap). The calibration check (manual spot-check) is the load-bearing trust mechanism. Skip the calibration and you have a fast eval that you can't actually trust.

## Primary diagram — the full recap

```
  LLM-as-judge bias mitigation in this codebase

  ┌─ Phase 3 (retired) ────────────────────────────────────────┐
  │  Judge: Sonnet 4.6 (same as agent — self-preference risk)  │
  │  Position bias: not applicable (no pairwise)               │
  │  Verbosity bias: NOT explicitly defended (no length rubric)│
  │  Self-preference: defended only by manual spot-check       │
  │  Calibration: 8/8 + 3/3 manual review                      │
  │  Status: retired with Olist substrate (PR #8)              │
  └────────────────────────────────────────────────────────────┘

  ┌─ Next iteration (planned, against Synthetic) ──────────────┐
  │  Judge model: Haiku for structured rubric items            │
  │                Sonnet for prose rubric items                 │
  │                cross-family where available                  │
  │  Position bias: randomize pairwise comparisons              │
  │  Verbosity bias: add "is the response concise?" rubric item │
  │  Self-preference: Haiku judges Sonnet (cross-size)          │
  │  Calibration: ~10-20 manual samples per pillar, recheck    │
  │                on rubric/prompt changes                       │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why this matters even though there's no eval today.** The Phase 3 retirement is recent (2026-06-18). When the next iteration lands (`B5.1` in `01-eval-set-types.md`), the bias defenses have to be designed in from the start. Bolting them on after — discovering the judge prefers verbose recommendations 3 months in — means throwing out months of eval data.

The discipline is to design the rubric + judge model + calibration plan BEFORE running the first at-scale eval. Phase 3 did this; the next iteration should too.

**The cross-family-judge cost.** Using a different model family as judge (e.g. GPT-4o judging Claude) means adding an OpenAI dependency. Not free; possibly not worth it for this codebase. The reasonable compromise is cross-size (Haiku judging Sonnet) — still same family, but the model is smaller and trained with different emphasis, which reduces (not eliminates) self-preference.

If a future product release REALLY needs strong self-preference defense (regulatory, etc.), bring in the cross-family judge despite the dependency cost.

**Why the rubric is the load-bearing defense, not the judge model.** Three reasons:

  1. **Rubric ambiguity is your largest source of variance.** A precise rubric ("does the conclusion cite at least one tool result?") gets consistent scores from almost any judge. A vague rubric ("is it good?") gets inconsistent scores from even the best judge.
  2. **Rubric is portable across judge changes.** Swap from Sonnet-judge to Haiku-judge tomorrow; if the rubric is precise, the scores stay comparable.
  3. **Rubric is debuggable.** When the judge disagrees with the human spot-check, you can trace exactly which rubric dimension was misread. With a vague rubric, you can't.

## Project exercises

### Exercise — Haiku-as-judge with rubric precision and randomized pairwise

  → **Exercise ID:** B5.3
  → **What to build:** Extend the eval runner (`B5.2` in `02-eval-methods.md`) to use Haiku as judge for the structured dimensions (`feature` enum, `severity`, `metric`) and Sonnet for prose dimensions (`conclusion`, `rationale`). For any pairwise comparison (prompt v1 vs v2), randomize the order per evaluation and aggregate by hidden label. Add a "conciseness" rubric dimension to the recommendation scorer to defend verbosity bias.
  → **Why it earns its place:** lands all three bias defenses (family swap via Haiku-as-structured-judge, randomization for pairwise, conciseness rubric item) from the start. Codifies the lessons from Phase 3's known limitation (Sonnet-judging-Sonnet) into the next iteration's design.
  → **Files to touch:** `eval/judge.ts` (per-method model selection), `eval/methods.ts` (randomized-order pairwise), `eval/seeds.ts` (add conciseness as a rubric dimension on recommendations).
  → **Done when:** running `npm run eval` shows per-judge-model cost in the report, pairwise comparisons report a hidden-label-balanced score, the conciseness dimension fires on artificially-verbose outputs, and the calibration spot-check passes against the new design.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Why was Sonnet judging Sonnet a limitation in your Phase 3 eval?"**

Self-preference bias by construction — when a model judges output from its own family, it tends to score those outputs higher than equally-good outputs from another family. Phase 3 used Sonnet 4.6 as both agent and judge. The defense was the 8/8 + 3/3 manual spot-check — every sample the human reviewed agreed with the judge — but the structural bias was still there. The next iteration uses Haiku as judge for structured rubric items (cross-size defense), keeping Sonnet only for prose rubric items where the smaller model's reasoning isn't enough.

True cross-family (e.g. GPT-4o judging Claude) is the strongest defense; not worth the OpenAI dependency for this codebase.

*Anchor: "Phase 3 known limitation: Sonnet self-judging. Next iteration: Haiku for structured rubric items."*

**Q: "How would you defend against verbosity bias?"**

Two defenses, layered. First, add a concise rubric dimension: "is the response appropriately concise?" scored 1-5. Now the judge can't reward verbosity without losing points on conciseness. Second, cap effective length in the prompt: "ignore anything past 500 tokens" (crude but works). The Phase 3 recommendation rubric didn't have a conciseness item — possibly why recommendations got verbose over iterations. The next iteration adds it.

The bigger principle: don't hope the judge ignores verbosity. Make verbosity an explicit dimension that's scored against, so verbosity becomes a known cost.

*Anchor: "Rubric-score length explicitly. Implicit ignorance of bias fails."*

## See also

  → `02-eval-methods.md` — the LLM-as-judge method this file calibrates
  → `01-eval-set-types.md` — the sets these calibration patterns apply to
  → `01-llm-foundations/03-sampling-parameters.md` — adjacent: how sampling defaults contributed to Phase 3's conclusion-instability finding
