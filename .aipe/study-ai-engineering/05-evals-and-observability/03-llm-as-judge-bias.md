# LLM-as-judge bias (and how to debias it)

**Industry name(s):** LLM-as-judge / model-graded eval, position bias, verbosity bias, self-preference / self-enhancement bias, judge calibration
**Type:** Industry standard · Language-agnostic

> When you use a model to score another model's output, the judge is itself a non-deterministic model with systematic biases — it favors the first option, the longer answer, and outputs from its own family — and a judge with uncorrected bias produces an eval score that measures the bias, not the quality. blooming insights now ships three LLM-as-judge surfaces (`eval/judges/diagnosis-judge.md`, `recommendation-judge.md`, `similarity-judge.md`), all running on `claude-sonnet-4-6` — the SAME family as the agents — so self-preference bias is the live trap. The mitigation in place is **per-criterion rubrics + manual-vs-judge calibration receipts** (diagnosis 8/8, recommendation 3/3); cross-family judging is the remaining Case-B gap.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** LLM-as-judge sits inside the eval band as one *option* for the scorer (alongside exact-match and rubric — see → 02-eval-methods.md). It is itself a Provider call — a second LLM that grades the system-under-test's output — which makes the eval flow look like a smaller version of the request flow. The bias surface (position, length, self-preference) is what this file is about: the judge's prejudices that distort the score before any decision is made on top of it.

```
  Zoom out — where the judge sits inside the eval band

  ┌─ Per-agent under test ───────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly)             │
  │  → produced Diagnosis (prose)                     │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Eval band — scorer ────▼────────────────────────┐  ← we are here
  │  ★ LLM-as-judge (a Provider call inside eval) ★   │
  │  "is A or B better?"  or  "score this 1–5"        │
  │  BIASES that distort the score:                   │
  │    - position bias (whichever listed first wins)  │
  │    - length bias  (verbose wins)                  │
  │    - self-preference (same family rated higher)   │
  │  debias by: randomize order, control length,      │
  │             use a different model family          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Eval score (acted on) ─▼────────────────────────┐
  │  trustworthy ⇒ ship; biased ⇒ confident lie       │
  └──────────────────────────────────────────────────┘

  Currently in this codebase: three LLM-as-judges ARE
  wired (diagnosis, recommendation, similarity for
  regression) — all on `claude-sonnet-4-6`, same family
  as the agents → self-preference live. The mitigations
  in place: per-criterion rubrics + manual-vs-judge
  calibration receipts (diagnosis 8/8, recommendation
  3/3 incl BRL-bug catch). Cross-family judging is the
  remaining Case-B gap.
```

**Zoom in — narrow to the concept.** The question is: when you delegate quality scoring to a model, what systematic errors does that judge introduce, and how do you correct them so the score reflects the answer's quality rather than the judge's prejudices? An uncorrected judge turns your eval into a confident lie — a biased judge still returns a clean number, and a number is persuasive. The fixes (randomized order, length controls, cross-family judging) are cheap; not applying them is how teams ship "data-driven" decisions powered by noise. How it works walks each bias, the cheap correction, and why a judge of the same family flatters the system it grades.

---

## Structure pass

**Layers.** Three layers, nested in the eval band: the per-agent under test (produces output), the judge call (a second LLM grading that output — itself a provider call with the same probabilistic properties), and the eval score that gets acted on. The judge looks like a smaller request flow inside the eval flow.

**Axis: guarantees.** What does the judge's score actually guarantee — quality, or the judge's own systematic prejudices? This axis is the right lens because the file's whole frame is "an uncorrected judge produces a confident lie." The bias surface (position, length, self-preference) means the judge's *guarantee* is "I'll return a clean number" — but not necessarily a *correct* number. Cost is downstream; the upstream question is whether the score is trustworthy.

**Seams.** The cosmetic seam is between the per-agent output and the judge's prompt — both are just strings. The load-bearing seam is between the judge call and the eval score: guarantees flip here from "probabilistic-with-known-biases" to "actionable number." The debiasing mechanisms (randomize order, control length, cross-family judge) sit *at* this seam — without them, the seam carries the judge's prejudices straight into shipping decisions. A useful parallel: the judge is to evals what the model is to live requests — same trust discipline, different layer.

```
  Structure pass — LLM-as-judge bias

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  per-agent under test (output)                 │
  │  judge call (a second LLM, biased)             │
  │  eval score (acted on)                         │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  guarantees: quality measurement, or judge's   │
  │  systematic prejudices?                        │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  output↔judge prompt: cosmetic                 │
  │  judge↔score: LOAD-BEARING                     │
  │    probabilistic biased call → actionable num  │
  │    debias HERE: position, length, family       │
  │    without it: confident lie ships             │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

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

**Fix — randomize and/or average both orders.** Present each pair in a random order per case, or run the comparison twice (A,B then B,A) and count a win only when the judge is consistent across both orders; ties (the judge flips) are discarded or scored 0.5. For a prompt A/B (comparing two versions of the diagnostic prompt), this is the difference between a real win-rate and a coin flip dressed as data.

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

**Fix — cap or control for length.** Cap the answer length the judge sees (truncate or instruct the agent to a length budget), or include length-neutrality in the judge instructions ("do not reward length; penalize padding"), or normalize the score by length post-hoc. In this system, a `Diagnosis` has bounded structure — `conclusion`, `evidence[]`, `hypothesesConsidered[]` — so the cleanest control is a rubric that scores *per criterion* (did it name a specific cause? cite scoped evidence?) rather than a holistic "how good is this," which is where verbosity bias enters.

### Self-preference bias — the judge favors its own family

A model rates outputs from its own family higher than outputs from other families, independent of quality — it recognizes its own style and rewards it. This is the most dangerous bias in this system specifically, because the agents run on a single shared `AGENT_MODEL` (a sonnet-class Claude model). **Judging that model's output with a judge of the same family is textbook self-preference — the eval flatters exactly the system it is supposed to scrutinize.**

```
self-preference in this system
─────────────────────────────────────────────────────────────
agent output:  AGENT_MODEL (sonnet-class)
judge:         AGENT_MODEL (sonnet-class)  ← SAME family
result:        judge over-rates its own family's phrasing
               eval reports "quality is high" because the judge
               likes its own style, not because the answer is good
```

**Fix — use a cross-family judge.** Score the agent's output with a judge from a *different* family (a GPT-class or Gemini-class model, or at minimum a different Claude tier evaluated for the same effect). The judge's stylistic preferences then no longer align with the system under test, so a high score means the answer is genuinely good, not that the judge recognized itself.

```
debiased judge selection
─────────────────────────────────────────────────────────────
agent: AGENT_MODEL (sonnet-class)  ──judged by──▶  different-family model
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

### Code in this codebase

**Case A — partial. The trap is acknowledged-and-receipted, not avoided.**

blooming insights now ships three LLM-as-judge surfaces, all running `claude-sonnet-4-6` — the **same family** as the agents (`AGENT_MODEL` at `lib/agents/base.ts:10`). That is self-preference bias by construction. The mitigations actually in place are per-criterion rubrics (verbosity-bias control) and standing manual-vs-judge calibration spot-checks (the human-eval rung from `02-eval-methods.md` applied as receipts).

#### Diagnosis judge

- **File:** `eval/judges/diagnosis-judge.md` (the prompt, ~235 lines) + `eval/scripts/lib/judge.ts` (the harness)
- **Model:** `claude-sonnet-4-6` — same family as the agent it judges (self-preference live)
- **Verbosity control:** per-criterion rubric (5 criteria — hypothesis 0-2, evidence 0-2, sizing 0-2, calibration 0-1, fabrication 0-2 — total 0-9; pass ≥ 7). Each criterion has explicit numeric ranges in the prompt, so a longer answer cannot win by being longer; it has to *satisfy each criterion*.
- **Position control:** N/A — this is absolute scoring, not pairwise; no order to randomize.
- **Calibration receipt:** `eval/results/2026-06-15/diagnosis-summary.md` — 8/8 manual-vs-judge agreement on a stratified sample (lowest, highest, and mid-pack per anomaly). The judge consistently scores `calibration=0` when the candidate's `confidence: high` field is set; the spot-check confirms this is a real reading of the rubric (the agent overclaims), not a judge artifact.

#### Recommendation judge

- **File:** `eval/judges/recommendation-judge.md` (~243 lines) + `eval/scripts/lib/judge-rec.ts`
- **Model:** `claude-sonnet-4-6` — same self-preference caveat
- **Verbosity control:** per-criterion rubric (3 criteria — plausible 0-2, specific 0-2, impact_sized 0-1; pass ≥ 4)
- **Calibration receipt:** `eval/results/2026-06-15/recommendation-summary.md` — 3/3 manual-vs-judge agreement on a stratified sample. The receipt that proves the judge isn't rubber-stamping: at run 8 of `electronics-spike-w2` it scored `impact_sized=0` on a recommendation citing `R$131,965 AOV → $26K/order`, correctly catching the BRL cents-vs-Reais bug and dropping the run from 5/5 to 4/5. **The judge IS critical when warranted.**

#### Similarity judge (regression)

- **File:** `eval/judges/similarity-judge.md` (~225 lines) + `eval/scripts/lib/similarity-judge.ts`
- **Model:** `claude-sonnet-4-6` — same self-preference caveat
- **Verbosity control:** the rubric asks for a yes/no semantic match plus a confidence and a `notes` / `differences` array — not a holistic score, so length is not the lever.
- **Calibration receipt:** the 30% semantic pass-rate baseline at `eval/results/2026-06-15-score-baseline/regression-summary.md` is itself a calibration anchor — running capture-then-immediately-score against identical prompts produces 30% match, which means *any* prompt edit must clear that floor to count as a non-regression. The `differences` arrays in the failure cases (see `regression-summary.md`) are the receipts the human can spot-check.

#### What's NOT done — the named gaps

- **Cross-family judging.** The remaining Case-B gap. A GPT-class or Gemini-class judge model would remove the self-preference axis; today it's a known cost paid in exchange for keeping the eval suite single-provider (Anthropic SDK only).
- **Pairwise comparison.** No swap-and-average mode exists — the three judges all do absolute scoring. Adding pairwise is the exercise in `02-eval-methods.md`.
- **Panel of judges.** No multi-family ensemble; the single-judge per surface is what's wired.

The standing calibration discipline (manual spot-checks on stratified samples, committed alongside each result dir) is the *honest substitute* for cross-family judging today: it accepts the bias and audits its effect, rather than removing it.

---

## LLM-as-judge bias — diagram

This diagram spans the Eval-harness layer (which controls the protocol around the judge) and the Provider boundary (the judge model itself). A reader who sees only this should grasp that debiasing is a protocol *around* the judge call — order, length, and family are controlled by the harness, not by the model.

```
┌──────────────────────────────────────────────────────────────────────┐
│  EVAL HARNESS  (evals/scorers/judge.ts — NEW)                       │
│                                                                       │
│   agent output (AGENT_MODEL, sonnet-class) + reference/rubric          │
│        │                                                              │
│   ┌────▼─────────────────────────────────────────────────────┐       │
│   │  DEBIAS PROTOCOL (applied before the judge call)          │       │
│   │   position:  randomize order / run both (A,B)+(B,A)       │       │
│   │   verbosity: cap length / per-criterion rubric            │       │
│   │   family:    select a CROSS-FAMILY judge (not same family)│       │
│   └────┬──────────────────────────────────────────────────────┘       │
│        │ judge prompt (order-randomized, length-controlled)            │
└────────┼──────────────────────────────────────────────────────────────┘
         │  PROVIDER BOUNDARY
┌────────▼──────────────────────────────────────────────────────────────┐
│   JUDGE model — DIFFERENT family from AGENT_MODEL                     │
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

## Project exercises

### Add a cross-family judge for diagnosis (close the self-preference gap)

- **Exercise ID:** B3.3 / B3.7 (adapted) — the actual remaining gap.
- **What to build:** extend `eval/scripts/lib/judge.ts` to accept a `--judge-model` flag (defaulting to `gpt-4o` or `gemini-2.0-pro` — anything NOT in the Claude family), and add the corresponding SDK as a dev dependency. Re-run `eval:diagnosis` with both judges side-by-side and add a per-criterion **judge-family agreement table** to the resulting `summary.md` ("does GPT agree with Sonnet on hypothesis score? on fabrication?"). Where they disagree, the Sonnet judge is the suspect side (because it's the family being judged).
- **Why it earns its place:** the codebase ships the eval suite and accepts self-preference as a known cost. Closing this is the proof you would not let a sonnet judge be the ONLY voice scoring sonnet output, even though that's where you started.
- **Files to touch:** `eval/scripts/lib/judge.ts` (configurable provider), `eval/scripts/lib/judge-rec.ts` (same), `eval/judges/diagnosis-judge.md` (verify the prompt is portable — no Anthropic-specific tags), `package.json` (add the non-Anthropic SDK).
- **Done when:** `npm run eval:diagnosis -- --K=10 --judge-model=gpt-4o` runs to completion, and the resulting `summary.md` shows the agreement table between the two judges on the same K=10 candidates.
- **Estimated effort:** 1–2 days

### Standardize the calibration receipt format

- **Exercise ID:** C3.3 (provenance) — operationalize judge calibration.
- **What to build:** the diagnosis and recommendation summaries already include manual-vs-judge spot-checks, but the format is ad-hoc (a markdown table embedded in `summary.md`). Extract it into a reusable `eval/scripts/lib/calibration.ts` that takes a `manualScores.json` file + the judge output and produces a standardized receipt block (agreement rate per criterion, flag any rate < threshold). Add it to `run-recommendation.ts` and `run-diagnosis.ts` so every result dir carries one.
- **Why it earns its place:** the calibration discipline is the load-bearing mitigation in this codebase's self-preference handling. Making it mechanical (and CI-friendly) is the difference between "we did it once" and "every result dir has a receipt."
- **Files to touch:** `eval/scripts/lib/calibration.ts` (new), `eval/scripts/run-diagnosis.ts` + `run-recommendation.ts` (wire it), `eval/fixtures/manual-scores/<date>.json` (the human-scored sample).
- **Done when:** every new dated dir under `eval/results/` carries a standardized calibration receipt block in its `summary.md`.
- **Estimated effort:** <1 day

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

## See also

→ 02-eval-methods.md · → 01-eval-set-types.md · → 04-llm-observability.md · → ../04-agents-and-tool-use/01-agents-vs-chains.md

---
