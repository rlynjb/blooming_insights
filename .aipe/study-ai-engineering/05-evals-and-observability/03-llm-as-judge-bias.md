# LLM-as-judge bias (and how to debias it)

**Industry name(s):** LLM-as-judge / model-graded eval, position bias, verbosity bias, self-preference / self-enhancement bias, judge calibration
**Type:** Industry standard · Language-agnostic

> When you use a model to score another model's output, the judge is itself a non-deterministic model with systematic biases — it favors the first option, the longer answer, and outputs from its own family — and a judge with uncorrected bias produces an eval score that measures the bias, not the quality.

**See also:** → 02-eval-methods.md · → 01-eval-set-types.md · → 04-llm-observability.md · → ../04-agents-and-tool-use/01-agents-vs-chains.md

---

## Why care

You write a sort comparator and accidentally make it non-transitive — `cmp(a,b)` and `cmp(b,a)` do not agree. The sort silently produces garbage: the result depends on input order, not on the actual values. You would never ship that comparator. An LLM-as-judge is a comparator for output quality, and out of the box it is exactly that broken: ask it "is A or B better?" and it leans toward whichever you listed first, regardless of content. Swap the order and the winner flips. That is a non-transitive comparator deciding which prompt version you ship.

The question this file answers is: **when you delegate quality scoring to a model, what systematic errors does that judge introduce, and how do you correct them so the score reflects the answer's quality rather than the judge's prejudices?**

**Why answering it matters: an uncorrected judge turns your eval into a confident lie.** A biased judge still returns a clean number — 4.2/5, v2 wins 64% — and a number is persuasive. You will edit prompts and swap models based on it. If that number is driven by position, length, or family rather than substance, every decision you make on top of it is wrong, and you will not know, because the judge never reports its own bias. The fixes are cheap; not applying them is how teams ship "data-driven" decisions powered by noise.

Before debiasing:
- A pairwise eval favors whichever output is listed first → the "winner" is an artifact of ordering
- The judge rewards the longer, more verbose diagnosis → prompts drift toward padding
- A `claude-sonnet-4-6` judge rates `claude-sonnet-4-6` output higher → the eval flatters the system it grades

After:
- Order is randomized (or both orders averaged) → position cancels out
- Length is capped or controlled for → verbosity stops winning
- The judge is a different model family → self-preference is removed
- The score tracks quality, and decisions on top of it are sound

A debiased judge is the difference between a comparator you can sort with and one that reorders your priorities every time you swap the inputs.

---

## How it works

**Mental model.** Treat the judge as a measuring instrument with a known, reproducible *systematic error* — like a scale that always reads 200g heavy. You do not throw the scale out; you characterize the offset and subtract it. The three offsets are position, verbosity, and self-preference, and each has a mechanical correction. The goal is not a perfect judge (there is none) but a judge whose errors are controlled so they do not drive the score.

```
biased judge (raw)                 debiased judge (corrected)
─────────────────────────────      ──────────────────────────────────
score = f(quality,                 score = f(quality)
          position,                  ├ randomize/average order  (kills position)
          length,                    ├ cap/normalize length     (kills verbosity)
          family)                    └ cross-family judge        (kills self-pref)
unknown which factor drove it      score driven by quality alone
```

You cannot remove the biases from the model; you neutralize each one's *effect on the score* with a deliberate protocol around the judge call.

---

### Position bias — the judge favors order, not content

In a pairwise comparison ("is A or B better?"), the judge systematically prefers one position — usually the first. The same two outputs, swapped, can flip the winner. Left uncorrected, your win-rate measures how often the better output happened to be listed first.

```
position bias in action
─────────────────────────────────────────────────────────────
present (A=v1, B=v2) → judge picks A   "first one reads cleaner"
present (A=v2, B=v1) → judge picks A   ← SAME position, winner flipped
                                          content didn't decide; order did
```

**Fix — randomize and/or average both orders.** Present each pair in a random order per case, or run the comparison twice (A,B then B,A) and count a win only when the judge is consistent across both orders; ties (the judge flips) are discarded or scored 0.5. For blooming insights' prompt A/B (comparing two versions of `lib/agents/prompts/diagnostic.md`), this is the difference between a real win-rate and a coin flip dressed as data.

```
debiased pairwise
─────────────────────────────────────────────────────────────
run 1: (v1, v2) → judge: v2     ┐ consistent across both orders
run 2: (v2, v1) → judge: v2     ┘ → genuine v2 win
if run1=v2 but run2=v1 → judge flipped on order → tie (0.5)
```

### Verbosity bias — the judge rewards length

Judges systematically rate longer, more detailed answers higher even when the extra length adds no correctness — padding reads as thoroughness. Left uncorrected, your eval rewards prompts that produce verbose output, and prompt iteration drifts toward bloat.

```
verbosity bias in action
─────────────────────────────────────────────────────────────
diagnosis A: 2 sentences, correct, tight        → judge 3/5
diagnosis B: 5 sentences, same content + filler  → judge 4/5
                          ↑ longer ≠ better, but the judge rewards it
```

**Fix — cap or control for length.** Cap the answer length the judge sees (truncate or instruct the agent to a length budget), or include length-neutrality in the judge instructions ("do not reward length; penalize padding"), or normalize the score by length post-hoc. In blooming insights, a `Diagnosis` (`lib/mcp/types.ts` L64–L73) has bounded structure — `conclusion`, `evidence[]`, `hypothesesConsidered[]` — so the cleanest control is a rubric that scores *per criterion* (did it name a specific cause? cite scoped evidence?) rather than a holistic "how good is this," which is where verbosity bias enters.

### Self-preference bias — the judge favors its own family

A model rates outputs from its own family higher than outputs from other families, independent of quality — it recognizes its own style and rewards it. This is the most dangerous bias in blooming insights specifically, because the agents run on `claude-sonnet-4-6` (`AGENT_MODEL`, `lib/agents/base.ts` L9). **Judging `claude-sonnet-4-6` output with a `claude-sonnet-4-6` judge is textbook self-preference — the eval flatters exactly the system it is supposed to scrutinize.**

```
self-preference in blooming insights
─────────────────────────────────────────────────────────────
agent output:  claude-sonnet-4-6  (AGENT_MODEL, base.ts L9)
judge:         claude-sonnet-4-6  ← SAME family
result:        judge over-rates its own family's phrasing
               eval reports "quality is high" because the judge
               likes its own style, not because the answer is good
```

**Fix — use a cross-family judge.** Score `claude-sonnet-4-6` agent output with a judge from a *different* family (a GPT-class or Gemini-class model, or at minimum a different Claude tier evaluated for the same effect). The judge's stylistic preferences then no longer align with the system under test, so a high score means the answer is genuinely good, not that the judge recognized itself.

```
debiased judge selection
─────────────────────────────────────────────────────────────
agent: claude-sonnet-4-6  ──judged by──▶  different-family model
                                           (no self-recognition)
high score now means "good answer", not "judge likes its own voice"
```

### Calibration — does the judge agree with humans

The biases above are systematic; the residual question is whether the judge, debiased, actually tracks human judgment at all. You measure this once: have humans score a sample, have the debiased judge score the same sample, and compute agreement. If agreement is low, the judge score is decorative no matter how clean the protocol.

```
calibration check
─────────────────────────────────────────────────────────────
sample of 20 cases → human scores  ┐
                   → judge scores   ┤→ agreement ≥ threshold?
                                     └  yes → trust the judge at scale
                                        no  → fix rubric or pick another judge
```

### The principle

A model that scores another model is an instrument with reproducible systematic error, not an oracle. Its three offsets — position (favors order), verbosity (favors length), self-preference (favors its own family) — each have a mechanical correction: randomize order, control length, judge cross-family. You apply all three and then calibrate against humans, because a judge whose biases drive the score does not measure quality — it measures itself, and a clean number from a biased judge is more dangerous than no number, because you will act on it.

---

## LLM-as-judge bias — diagram

This diagram spans the Eval-harness layer (which controls the protocol around the judge) and the Provider boundary (the judge model itself). A reader who sees only this should grasp that debiasing is a protocol *around* the judge call — order, length, and family are controlled by the harness, not by the model.

```
┌──────────────────────────────────────────────────────────────────────┐
│  EVAL HARNESS  (evals/scorers/judge.ts — NEW)                       │
│                                                                       │
│   agent output (claude-sonnet-4-6) + reference/rubric                  │
│        │                                                              │
│   ┌────▼─────────────────────────────────────────────────────┐       │
│   │  DEBIAS PROTOCOL (applied before the judge call)          │       │
│   │   position:  randomize order / run both (A,B)+(B,A)       │       │
│   │   verbosity: cap length / per-criterion rubric            │       │
│   │   family:    select a CROSS-FAMILY judge (not sonnet)     │       │
│   └────┬──────────────────────────────────────────────────────┘       │
│        │ judge prompt (order-randomized, length-controlled)            │
└────────┼──────────────────────────────────────────────────────────────┘
         │  PROVIDER BOUNDARY
┌────────▼──────────────────────────────────────────────────────────────┐
│   JUDGE model — DIFFERENT family from claude-sonnet-4-6               │
│   returns score / winner                                              │
└────────┬──────────────────────────────────────────────────────────────┘
         │ aggregate
┌────────▼──────────────────────────────────────────────────────────────┐
│  CALIBRATION  (one-time): judge vs. human agreement ≥ threshold?      │
│   yes → trust at scale     no → fix rubric / change judge             │
└───────────────────────────────────────────────────────────────────────┘
```

The model is the instrument; the harness is the protocol that subtracts its known offsets before the number is trusted.

---

## In this codebase

**Not yet implemented.** blooming insights has no LLM-as-judge — there is no judge model wired for evaluation, no pairwise comparison code, and no debiasing protocol, because (per `01-eval-set-types.md` and `02-eval-methods.md`) there is no eval harness at all.

The relevant codebase fact is the *trap waiting to be sprung*: the agents run on `claude-sonnet-4-6` (`AGENT_MODEL`, `lib/agents/base.ts` L9), and the intent classifier on `claude-haiku-4-5` (`CLASSIFIER_MODEL`, `lib/agents/intent.ts` L14). The naive first eval anyone builds will reach for the SDK already in the repo and judge sonnet output with a sonnet judge — the exact self-preference mistake this file exists to prevent.

Where the debiased judge would live: `evals/scorers/judge.ts` (the protocol-wrapped judge call) and `evals/scorers/pairwise.ts` (order-randomized comparison), both consumed by `evals/runner.ts` from `02-eval-methods.md`. The judge model must be configured to a different family than `claude-sonnet-4-6`. The exercise below is that scorer.

---

## Elaborate

### Where this pattern comes from

LLM-as-judge emerged because human evaluation does not scale and classical metrics (BLEU, ROUGE) correlate poorly with human preference on open-ended generation. The seminal work is "Judging LLM-as-a-Judge" (Zheng et al., the MT-Bench / Chatbot Arena lineage), which both validated that strong models approximate human preference *and* documented the systematic biases — position, verbosity, self-enhancement — that make a raw judge unreliable. The debiasing protocol (swap-and-average for position, length controls for verbosity, cross-family or panel-of-judges for self-preference) is the accumulated mitigation from that literature.

### The deeper principle

```
bias            what it confounds with quality   correction
──────────────  ──────────────────────────────   ──────────────────────────
position        presentation order               randomize / average orders
verbosity       answer length                    cap length / per-criterion
self-preference judge's own family/style         cross-family judge / panel
(residual)      everything else                  calibrate vs. human labels
```

Every bias is a confound — a variable correlated with the score that is not quality. The fix for a confound is the same everywhere in measurement: hold it constant, randomize it out, or control for it statistically. The judge is not special; it is a measurement with confounds, and you treat it like one.

### Where this breaks down

1. **Cross-family judging trades one bias for another.** A GPT-class judge has its *own* style preferences; it just does not share sonnet's. A single cross-family judge removes self-preference but adds that judge's idiosyncrasies. A panel of judges from multiple families, averaged, is the more robust answer when stakes are high.

2. **Order randomization needs enough cases.** Randomizing per case only cancels position bias *in aggregate*. On a 10-case set, the randomization can still skew. Either average both orders per case (deterministic cancellation) or use enough cases that the random assignment balances.

3. **Verbosity controls can suppress genuine detail.** Capping length to fight verbosity bias can penalize an answer that is legitimately longer because it correctly considered more hypotheses. A per-criterion rubric is better than a blunt length cap precisely because it scores *whether each required point is present*, not *how long the answer is*.

### What to explore next

- **Panel of LLM judges (jury):** average scores from 2–3 different families to wash out any single judge's idiosyncrasy; the production-grade version of cross-family.
- **Reference-guided judging:** give the judge the golden reference answer, not just the output, so it scores against a fixed target rather than its own prior — reduces all three biases.
- **Bias auditing:** periodically feed the judge identical-content pairs in both orders and measure flip-rate; a rising flip-rate signals position bias creeping back.

---

## Tradeoffs

### Debiased cross-family judge vs. raw same-family judge vs. human-only

| Dimension | Debiased cross-family judge | Raw same-family judge (sonnet judges sonnet) | Human-only |
|---|---|---|---|
| Self-preference | Removed (different family) | Severe — flatters its own output | None |
| Position bias | Removed (order randomized/averaged) | Present — winner flips on swap | Low (humans also have some) |
| Verbosity bias | Controlled (rubric/length cap) | Present — rewards padding | Low |
| Cost per case | 1–2 judge calls (both orders) | 1 judge call | Human time |
| Scalability | High | High | Low |
| Trustworthiness of the number | High after calibration | Low — number measures bias | Highest (it IS the ground truth) |
| Setup effort | Protocol + a second-provider key | Drop-in (SDK already present) | Recruit + train raters |

**What we gave up (by not having it).** Nothing today — there is no judge — but the latent cost is the seductiveness of the wrong default. The repo ships the Anthropic SDK and runs sonnet; the path of least resistance is a sonnet-judges-sonnet eval, which is *worse than no eval* because it returns a flattering number with a methodology that guarantees flattery. The cost of skipping debiasing is a quality metric that systematically over-reports.

**What the alternative would have cost.** A raw same-family judge costs one API key and zero protocol code — and produces a number that moves with position, length, and family rather than quality. Human-only evaluation produces the most trustworthy number and does not scale to running on every prompt edit. The debiased cross-family judge is the middle that is both scalable and honest, at the cost of a second provider credential and the swap-and-average protocol.

**The breakpoint.** A raw judge (any biases) is tolerable *only* for throwaway exploratory spot-checks where you eyeball the outputs anyway. The instant a judge score drives a decision — ship this prompt, swap this model — debiasing becomes mandatory, because the decision inherits the bias. Self-preference correction specifically becomes mandatory the moment the judge family equals the agent family, which in blooming insights is the default (`claude-sonnet-4-6` on both sides) unless you deliberately choose otherwise.

---

## Tech reference (industry pairing)

### position-bias correction

- **Codebase uses:** nothing — no pairwise judging exists.
- **Why it's here (absent):** prompt/model A/B comparison is a future need with no current code.
- **Leading today:** swap-and-average (run both orders, require consistency) is the standard position-bias control (2026).
- **Why it leads:** deterministically cancels order effects per case rather than relying on aggregate randomization.
- **Runner-up:** per-case random order — cheaper (one call), only cancels in aggregate over many cases.

### verbosity-bias correction

- **Codebase uses:** nothing — but `Diagnosis` (`lib/mcp/types.ts` L64–L73) is naturally bounded, easing the control.
- **Why it's here (absent):** no holistic judge yet to exhibit length preference.
- **Leading today:** per-criterion rubric scoring plus explicit length-neutral judge instructions (2026).
- **Why it leads:** scores presence of required content, not length, so padding cannot win.
- **Runner-up:** hard length caps — simpler, can suppress legitimately longer correct answers.

### self-preference correction / cross-family judging

- **Codebase uses:** nothing — agents run `claude-sonnet-4-6` (`lib/agents/base.ts` L9); no separate judge family is configured.
- **Why it's here (absent):** no judge exists; the naive default would be same-family.
- **Leading today:** cross-family judges and multi-family juries (averaging GPT/Claude/Gemini-class judges) are the standard self-preference control (2026).
- **Why it leads:** the judge's style preferences no longer align with the system under test, so a high score reflects quality.
- **Runner-up:** reference-guided judging — anchor to a golden answer to dampen self-style preference without a second provider.

---

## Project exercises

### Build a debiased LLM-as-judge for diagnosis quality

- **Exercise ID:** B3.3 / B3.7 (adapted) — the debiased judge, the primary buildable target.
- **What to build:** `evals/scorers/judge.ts` that scores `DiagnosticAgent` output against a golden reference with all three corrections wired in: a configurable judge model defaulting to a *different family* than `claude-sonnet-4-6` (self-preference), a per-criterion rubric prompt with length-neutral instructions (verbosity), and — for pairwise mode — swap-and-average over both orders (position). Expose a `flipRate` diagnostic that reports how often the judge changes its verdict on order swap.
- **Why it earns its place:** demonstrates you treat the judge as a biased instrument and correct each offset — the precise senior signal that you do not trust a model-graded number blindly, and specifically that you would never let sonnet judge sonnet.
- **Files to touch:** `evals/scorers/judge.ts`, `evals/scorers/pairwise.ts` (swap-and-average), `evals/runner.ts` (wires the judge); judge model config separate from `AGENT_MODEL` in `lib/agents/base.ts` L9; references the `Diagnosis` shape in `lib/mcp/types.ts` L64–L73.
- **Done when:** the judge defaults to a non-sonnet family, pairwise mode runs both orders and reports a `flipRate`, and a holdout of human-scored cases shows judge-human agreement above your chosen threshold.
- **Estimated effort:** 1–2 days

### Add a one-time human-calibration harness

- **Exercise ID:** C3.3 (provenance) — judge calibration.
- **What to build:** a small script that takes a sample of golden cases, records human scores alongside the debiased judge scores, and prints an agreement metric (e.g. Cohen's kappa or rank correlation) so the judge is validated before it is trusted at scale.
- **Why it earns its place:** shows you close the loop — a debiased judge is still only as good as its agreement with the humans whose judgment it approximates.
- **Files to touch:** `evals/calibrate.ts`, reads `evals/fixtures/golden.json`, uses `evals/scorers/judge.ts`.
- **Done when:** the script outputs a judge-human agreement score for the sample and flags it pass/fail against a threshold.
- **Estimated effort:** 1hr–1day

---

## Summary

An LLM-as-judge is a non-deterministic model with reproducible systematic biases: position (favors the first option), verbosity (favors the longer answer), and self-preference (favors its own family). Each has a mechanical correction — randomize/average order, cap or rubric-control length, judge cross-family — and after correcting them you calibrate the judge against human scores. In blooming insights the live trap is concrete: the agents run `claude-sonnet-4-6` (`lib/agents/base.ts` L9), so the naive default of judging sonnet with sonnet is textbook self-preference. The debiased judge lives in `evals/scorers/judge.ts` and must use a different model family.

**Key points:**
- A raw judge scores `f(quality, position, length, family)`; debiasing isolates `f(quality)`.
- Position → randomize/average both orders; verbosity → cap length or per-criterion rubric; self-preference → cross-family judge.
- Judging `claude-sonnet-4-6` with `claude-sonnet-4-6` (`lib/agents/base.ts` L9) is self-preference by construction.
- A clean number from a biased judge is worse than no number — you will act on it.
- Calibrate against humans; an uncalibrated judge score is decorative.

---

## Interview defense

### What an interviewer is really asking

"You use an LLM to grade your LLM — how do you know the grades are real?" tests whether you know the judge is biased and whether you can name the specific biases and their fixes. The tell of a junior answer is treating the judge as objective. The senior signal is naming position/verbosity/self-preference, giving the mechanical fix for each, and — for this codebase — immediately flagging that judging sonnet with sonnet is self-preference.

### Likely questions

**[mid] What's wrong with using one `claude-sonnet-4-6` call to judge another `claude-sonnet-4-6` answer?**

Self-preference bias: a model over-rates its own family's style independent of quality. Since the agents run `claude-sonnet-4-6` (`lib/agents/base.ts` L9), a sonnet judge flatters exactly the system it grades. The fix is a cross-family judge so the judge's style preferences do not align with the system under test.

```
sonnet agent → sonnet judge → over-rates own style (self-preference)
sonnet agent → other-family judge → score tracks quality
```

**[senior] Your pairwise prompt A/B says v2 wins 64%. How do you know that's not position bias?**

I randomize or, better, average both orders: judge (v1,v2) and (v2,v1), and count a win only when the verdict is consistent across both. If the judge flips on swap, that case is a tie. I also report a `flipRate`; a high flip-rate means position is driving the result and the 64% is an artifact.

```
(v1,v2)→v2 and (v2,v1)→v2 → real v2 win
(v1,v2)→v2 but (v2,v1)→v1 → flip → tie, not a win
```

**[arch] How do you stop your eval from rewarding verbose diagnoses?**

Score per criterion with a rubric instead of a holistic "how good is this," because verbosity bias enters through holistic scoring. A `Diagnosis` (`lib/mcp/types.ts` L64–L73) decomposes into checkable points — names a specific cause, cites scoped evidence, considers ≥2 hypotheses — and a rubric scores their *presence*, not the answer's length, so padding adds words but not score.

```
holistic: longer reads as thorough → padding wins
rubric:   each required point present? → length is irrelevant
```

### The question candidates always dodge

**"Cross-family judging removes self-preference — but doesn't the new judge have its own biases?"** Yes, and pretending otherwise is the tell. A GPT-class judge does not share sonnet's self-preference but has its own stylistic leanings. The honest answer is that a single cross-family judge removes the *worst* bias (self-recognition of the system under test) but is not bias-free; the robust fix when stakes are high is a panel of judges from multiple families, averaged, plus a one-time human calibration so you know the panel tracks human judgment at all. There is no unbiased judge — only controlled bias.

### One-line anchors

- Three biases: position (order), verbosity (length), self-preference (own family).
- Fixes: randomize/average order, cap/rubric length, cross-family judge.
- sonnet judging sonnet (`lib/agents/base.ts` L9) = self-preference by construction.
- A biased judge returns a clean number that measures bias, not quality.
- Calibrate against humans; cross-family removes self-pref but adds its own bias.

---

## Validate

### Level 1 — Reconstruct

From memory, name the three judge biases and the one-line mechanical fix for each. Then state which bias is the live trap in blooming insights and why.

### Level 2 — Explain

Out loud: why is a clean numeric score from a biased judge *more* dangerous than having no score at all? Tie it to the fact that you act on numbers.

### Level 3 — Apply

Scenario: a teammate builds the first eval and reaches for the Anthropic SDK already in the repo, judging diagnosis output with `claude-sonnet-4-6`. Open `lib/agents/base.ts` L9 — name the exact bias this introduces, why it is by construction, and the minimal change that fixes it.

### Level 4 — Defend

A colleague argues "cross-family judging is overkill — we'll just tell the judge to be objective in the prompt." Argue why an instruction does not remove a systematic bias, what swap-and-average and cross-family selection do that a prompt cannot, and when a single cross-family judge is still insufficient (panel of judges).

### Quick check — code reference test

What model do the diagnostic and recommendation agents run on, and why does that make the choice of judge model a bias decision? (Answer: `claude-sonnet-4-6` — `AGENT_MODEL` at `lib/agents/base.ts` L9 — so judging their output with another `claude-sonnet-4-6` call is self-preference bias by construction; the judge must be a different family for the score to reflect quality rather than the judge recognizing its own style.)

---
Updated: 2026-05-28 — Re-derived `Diagnosis` ref (types.ts L64–L73). `AGENT_MODEL` (base.ts L9) and `CLASSIFIER_MODEL` (intent.ts L14) verified unchanged — the sonnet-judges-sonnet self-preference trap still holds. Still Case B (no judge wired).
