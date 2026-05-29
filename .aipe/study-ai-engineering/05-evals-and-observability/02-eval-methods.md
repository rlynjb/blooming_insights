# Eval methods (the scoring ladder)

**Industry name(s):** evaluation methods / metrics, exact-match, fuzzy match, rubric grading, LLM-as-judge, pairwise comparison, human evaluation
**Type:** Industry standard · Language-agnostic

> Once you have an eval set, you need a way to turn an output into a score; the methods form a ladder from cheap-and-strict (exact-match) to expensive-and-nuanced (human review), and the right rung depends on the surface — blooming insights' anomaly classification fits exact-match/F1, its diagnosis and recommendation prose fit rubric or LLM-as-judge.

**See also:** → 01-eval-set-types.md · → 03-llm-as-judge-bias.md · → 04-llm-observability.md · → ../01-llm-foundations/07-heuristic-before-llm.md

---

## Why care

You compare two values in a test. For a number you write `toBe(42)`. For an object you reach for `toEqual({...})`. For a string that varies in whitespace you normalize first, then compare. For a string whose *exact* form you cannot predict you fall back to `toMatch(/regex/)` or `expect(s).toContain('...')`. You already pick the comparison method to fit the shape of the thing being compared — a stricter method for predictable output, a looser one for variable output.

Eval scoring is that same decision, scaled up. An anomaly classification is a single enum value (`'critical' | 'warning' | 'info' | 'positive'`) — predictable, so `toBe`-style exact-match works. A diagnosis is a paragraph of reasoning — unpredictable, so exact-match is useless and you need a rubric or a model to judge it. The question this file answers is: **for each surface in blooming insights, which scoring method is strict enough to catch real regressions but loose enough not to fail correct-but-differently-worded answers?**

**Why answering it matters: the wrong method makes your eval set lie to you.** Score free-form diagnosis prose with exact-match and every run "fails" because the wording shifts — the eval is noise. Score an anomaly's severity with an LLM-judge and you have spent a model call and introduced judge bias to grade what `===` would have graded for free and correctly. Method choice is what makes the score *trustworthy*; a number from the wrong method is worse than no number, because you will act on it.

Before matching method to surface:
- Diagnosis evals fail constantly on wording → the team ignores the score → evals are abandoned
- Anomaly-class evals run an expensive judge → slow, costs money, adds bias for no benefit
- "The eval is flaky" becomes the reason nobody trusts evals

After:
- Anomaly classification scored by exact-match / F1 — fast, free, deterministic, correct
- Diagnosis and recommendation prose scored by rubric or LLM-judge — tolerant of wording, sensitive to substance
- Each score means what it says, so the team acts on it

It is the same instinct as choosing `toBe` vs. `toMatch` — applied to a non-deterministic model and a far richer space of "correct."

---

## How it works

**Mental model.** Think of the methods as a ladder. Each rung up handles more output variability and more nuance, and costs more (compute, money, latency, human time). You climb only as high as the output's variability forces you to — the cheapest rung that does not produce false failures is the right one. This is the same discipline as `../01-llm-foundations/07-heuristic-before-llm.md`: do not reach for the model when a string compare suffices.

```
the scoring ladder (cheap/strict at bottom → expensive/nuanced at top)
─────────────────────────────────────────────────────────────────────
  human review        ▲  most nuanced, slowest, most expensive — gold standard
  pairwise            │  "is A better than B?" — relative, robust to scale drift
  LLM-as-judge        │  model scores prose vs. rubric — nuanced, has BIAS
  rubric grading      │  checklist of criteria — structured, partly automatable
  fuzzy match         │  F1 / ROUGE / embedding-sim — tolerant of wording
  exact-match         ▼  ===  — fastest, free, deterministic, zero tolerance
─────────────────────────────────────────────────────────────────────
  climb only as high as the output's variability forces you to
```

The lower rungs are deterministic and free; the upper rungs are judgment calls that cost a model call or a human. You match the rung to the surface, not the other way around.

---

### Rung 1 — exact-match (the `===` of evals)

Exact-match scores an output correct only if it equals the reference exactly. It is `toBe`. It works when the output space is small and predictable — an enum, a boolean, a single label.

```
exact-match on anomaly severity
─────────────────────────────────────────────
output:    "critical"
reference: "critical"
score:     output === reference ? 1 : 0   → 1
```

In blooming insights the natural fit is classification-shaped output. `classifyIntent` (`lib/agents/intent.ts` L17–L31) returns one of `'monitoring' | 'recommendation' | 'diagnostic'` — a one-word answer (it caps `max_tokens` at 16 to force this). An eval of intent classification is pure exact-match: the model said `diagnostic`, the reference is `diagnostic`, score 1. Severity classification on anomalies (`Severity` = `'critical' | 'warning' | 'info' | 'positive'`, `lib/mcp/types.ts` L3) is the same shape. No tolerance is needed because there is no correct variation in a single enum value.

### Rung 2 — fuzzy match (tolerance for wording)

Fuzzy match scores partial overlap rather than exact equality. For a *set* of expected items it is precision/recall/F1; for free text it is token overlap (ROUGE), edit distance, or embedding cosine similarity. It is `toContain` and normalized compares, generalized.

```
F1 on the SET of anomalies the monitoring agent flagged
─────────────────────────────────────────────────────────────
expected anomalies:  {mobile-conv-drop, ios-checkout-error, eu-bounce}
flagged anomalies:   {mobile-conv-drop, ios-checkout-error, paid-search-up}
                      ─────────── overlap=2 ───────────
precision = 2/3   (2 of 3 flagged were correct)
recall    = 2/3   (2 of 3 expected were caught)
F1        = 0.67  (harmonic mean)
```

`MonitoringAgent.scan` (`lib/agents/monitoring.ts` L68–L103) returns an *array* of anomalies, sorted by severity and sliced to the top 10. Its quality is not one label — it is a set: did it catch the anomalies that matter (recall) without flagging noise (precision)? F1 is the exact instrument. Exact-match is too strict here (the order or one extra item should not zero the score); a rubric is overkill (the items are structured, not prose).

### Rung 3 — rubric grading (a checklist for prose)

A rubric is a list of binary or scored criteria a good answer must satisfy. You decompose "is this diagnosis good?" into checkable sub-questions, each scored independently, then aggregate.

```
rubric for a Diagnosis
─────────────────────────────────────────────────────────────
[ ] conclusion names a specific cause (not "something changed")   weight 3
[ ] cites evidence tied to the anomaly's scope (mobile/checkout)  weight 2
[ ] considers ≥2 hypotheses (hypothesesConsidered non-trivial)    weight 2
[ ] does not hallucinate a metric not in the tool results         weight 3
                                                  score = Σ(passed×weight)/Σweight
```

A `Diagnosis` (`lib/mcp/types.ts` L64–L73) has `conclusion`, `evidence[]`, and `hypothesesConsidered[]`. Some criteria are checkable by code (is `hypothesesConsidered.length >= 2`? does `evidence` reference the anomaly's `scope`?); others need a judge. A rubric is the structured middle: more tolerant than exact-match (wording is free), more objective than a single holistic judge score (each criterion is explicit). It is the recommended first method for diagnosis and recommendation prose because it forces you to *define* what good means.

### Rung 4 — LLM-as-judge (a model grades the prose)

LLM-as-judge hands the output (and the reference or rubric) to a separate model and asks it to score. It handles nuance no checklist captures — tone, coherence, whether the reasoning actually follows — at the cost of a model call and judge bias (the whole subject of `03-llm-as-judge-bias.md`).

```
LLM-as-judge on a recommendation
─────────────────────────────────────────────────────────────
judge prompt: "Given anomaly X and diagnosis Y, rate this
               recommendation 1–5 on actionability and fit to
               the mapped Bloomreach feature. Justify."
output:  {title, rationale, bloomreachFeature:"scenario", steps[...]}
judge →  4/5 "concrete steps, correct feature, impact vague"
```

`RecommendationAgent.propose` (`lib/agents/recommendation.ts` L36–L77) produces `Recommendation` objects whose quality is genuinely subjective — is this action sensible, does the `bloomreachFeature` enum match the problem, are the `steps` concrete? A rubric covers the checkable parts; LLM-as-judge covers the holistic "would an expert endorse this." It is the rung you climb to when a rubric cannot capture the nuance — and you climb it knowing it imports bias you must control.

### Rung 5 — pairwise comparison (which of two is better)

Pairwise asks the judge a relative question — "is output A better than output B?" — instead of an absolute score. Relative judgments are more reliable than absolute ones (humans and models both rank better than they rate), and they are the natural method for comparing two prompt versions or two models.

```
pairwise for a prompt-edit A/B
─────────────────────────────────────────────────────────────
case → diagnostic.md v1 → output A ┐
     → diagnostic.md v2 → output B ┤→ judge: "A or B better?"
                                    └→ aggregate win-rate over the golden set
v2 wins 64% of cases → v2 is the better prompt
```

This is the method for the decisions blooming insights will actually face: did editing `lib/agents/prompts/diagnostic.md` help? Did the next model beat `claude-sonnet-4-6`? Run the golden set through both, judge pairwise, report a win-rate. Pairwise sidesteps the "is 0.82 good?" problem — you do not need a calibrated absolute scale, only a consistent relative one.

### Rung 6 — human evaluation (the gold standard)

Human review is an expert reading outputs and scoring them. It is the ground truth every other method approximates, and the source of the reference answers in the golden set. It is slow and expensive, so you use it to *calibrate* the cheaper methods (does the LLM-judge agree with humans?) and to spot-check, not to score every run.

```
human review's role
─────────────────────────────────────────────────────────────
authors golden references → defines "good"
calibrates the LLM-judge  → does judge agree with human ≥ X%?
spot-checks production     → feeds failures to the regression set
```

### Matching method to surface in blooming insights

```
surface                          output shape          method
───────────────────────────────  ────────────────────  ─────────────────────
classifyIntent (intent.ts)       one enum word         exact-match
anomaly severity (types.ts L3)   one enum              exact-match
MonitoringAgent.scan (set)       array of anomalies    fuzzy / precision-recall-F1
DiagnosticAgent.investigate      prose + structure     rubric → LLM-judge
RecommendationAgent.propose      subjective action     rubric → LLM-judge
prompt-edit / model A/B          two prose outputs     pairwise
calibration & golden authoring   anything              human
```

### The principle

Match the scoring method to the variability of the output, not to your enthusiasm for the technique. Exact-match for a label, F1 for a set, a rubric for structured prose, a judge for nuance, pairwise for comparisons, human for ground truth — and never climb a rung higher than the output forces you to, because every rung up costs more and the upper rungs import bias. The same engineer who picks `toBe` over `toMatch` when the output is predictable picks exact-match over LLM-judge for the same reason.

---

## Eval methods — diagram

This diagram spans the State layer (the eval set), the Eval-harness layer (which selects a scoring method per surface), and the Provider boundary (the LLM-judge, only for the upper rungs). A reader who sees only this should grasp that one harness routes each surface's output to the cheapest method that fits it.

```
┌──────────────────────────────────────────────────────────────────────┐
│  DATASET LAYER  (evals/fixtures/)                                    │
│   golden / adversarial / regression cases  {input, reference|rubric} │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ each case → run live agent → output
┌────────────────────────────────▼──────────────────────────────────────┐
│  EVAL HARNESS  (evals/runner.ts — NEW)                              │
│                                                                       │
│   route by surface to the cheapest fitting method:                    │
│                                                                       │
│   intent / severity ──────▶ exact-match (===)        ── free, local   │
│   monitoring set ─────────▶ fuzzy / F1               ── free, local   │
│   diagnosis structure ────▶ rubric (code + criteria) ── mostly local  │
│   diagnosis/rec nuance ───▶ LLM-as-judge ──┐         ── model call    │
│   prompt/model A/B ───────▶ pairwise ──────┤                          │
│                                            │                          │
└────────────────────────────────────────────┼──────────────────────────┘
                                             │  PROVIDER BOUNDARY (judge only)
┌────────────────────────────────────────────▼──────────────────────────┐
│   Anthropic API — a JUDGE model (cross-family, see 03-...-bias.md)    │
│   returns score / winner → aggregated into the run report             │
└───────────────────────────────────────────────────────────────────────┘
   lower rungs never touch the provider; only nuance/comparison climb up
```

One harness, many methods. The cheap rungs stay local and free; only diagnosis/recommendation nuance and A/B comparisons reach the Provider boundary for a judge.

---

## In this codebase

**Not yet implemented.** blooming insights has no eval harness and no scoring code — there is no `evals/runner.ts`, no exact-match scorer, no F1 computation over monitoring output, no rubric, and no LLM-as-judge. The closest existing code is *shape* validation (`lib/mcp/validate.ts` L17–L53), which is a pass/fail on structure, not a quality score.

You can confirm the absence: nothing in the repo compares an agent's output to a reference answer or assigns a quality score; the 157 Vitest tests assert structure and control flow against fakes (see `01-eval-set-types.md`).

Where the methods would live: a new `evals/runner.ts` that loads cases from `evals/fixtures/` (built in `01-eval-set-types.md`), runs the live agent, and dispatches each output to a scorer — `evals/scorers/exact.ts`, `evals/scorers/f1.ts`, `evals/scorers/rubric.ts`, `evals/scorers/judge.ts` — chosen by the case's declared surface. The judge scorer is hardened against bias in `03-llm-as-judge-bias.md`. The exercises below are the harness.

---

## Elaborate

### Where this pattern comes from

The ladder draws from three lineages. **Exact-match and F1** come straight from classical NLP and information retrieval — F1 has scored classifiers and retrieval systems for decades. **ROUGE/BLEU** (token-overlap fuzzy metrics) came from machine translation and summarization research. **LLM-as-judge and pairwise** are recent, born from the observation that human preference is expensive and that a strong model approximates it well enough to scale — Chatbot Arena popularized pairwise human/LLM preference as the dominant way to rank models. The ladder is the accumulated answer to "how do you score text when there is no single right answer?"

### The deeper principle

```
output variability        →  scoring method
─────────────────────────    ───────────────────────────────
one of N labels           →  exact-match (no tolerance needed)
a set of items            →  precision/recall/F1
structured prose          →  rubric (decompose into criteria)
free-form prose           →  LLM-judge (holistic) or pairwise (relative)
"better or worse?"        →  pairwise (relative beats absolute)
ground truth              →  human
```

The method tracks the *entropy* of the correct-answer space. A single enum has near-zero entropy → exact-match. A paragraph of reasoning has high entropy → you cannot enumerate correct answers, so you either decompose into criteria (rubric) or delegate the holistic judgment (judge/pairwise). The whole ladder is "how do I assert correctness when I cannot write down the one correct string?"

### Where this breaks down

1. **F1 hides which errors you made.** An F1 of 0.67 on monitoring output does not say whether you are missing critical anomalies (bad — low recall on what matters) or flagging noise (annoying but safe — low precision). Always report precision and recall separately and weight by severity; the aggregate alone misleads.

2. **Rubrics are only as good as their criteria.** A rubric that omits "does not hallucinate a metric" will score a confident, fluent, *fabricated* diagnosis highly. Writing the rubric is the hard, high-leverage work; the scoring is mechanical.

3. **LLM-judge introduces bias and cost on every case.** Position bias, verbosity bias, self-preference (`03-llm-as-judge-bias.md`) — and a model call per case. Climb to the judge only when the rubric genuinely cannot capture the nuance, and calibrate the judge against human scores before trusting it.

### What to explore next

- **G-Eval / chain-of-thought judging:** have the judge reason through the rubric step by step before scoring — more reliable than a bare 1–5 number.
- **Calibration against human labels:** measure judge-human agreement on a sample; if it is low, the judge score is decorative.
- **Severity-weighted F1 for monitoring:** weight recall on `critical` anomalies far above `info`, so the metric reflects the cost of a miss.

---

## Tradeoffs

### Climbing the ladder per surface vs. one method for everything

| Dimension | Method-per-surface (this guide) | Exact-match everything | LLM-judge everything |
|---|---|---|---|
| Cost per run | Mostly free (lower rungs), judge only for nuance | Free | A model call per case |
| Latency | Low | Lowest | High (a judge call each) |
| False failures on prose | None — prose uses rubric/judge | Constant — wording shifts fail | None |
| Wasted compute on labels | None — labels use exact-match | None | High — judging an enum |
| Bias introduced | Only on judged surfaces | None | Everywhere, even on labels |
| Sensitivity to real regressions | High — right tool per surface | Low on prose (always fails) | High but noisy/biased |

**What we gave up (by not having any of this).** Today there is no scoring at all, so there is no method to choose — but the latent cost is that whoever builds evals first will be tempted to pick one method for everything. Exact-match-everything is the seductive wrong choice (it is free and deterministic) and it makes diagnosis evals useless; LLM-judge-everything is the other wrong choice (it feels rigorous) and it burns money judging enums while importing bias.

**What the alternative would have cost.** A single-method harness is cheaper to build and a maintenance trap: the day you add a prose surface to an exact-match harness, your eval starts lying (false failures), and the day you add a label surface to a judge harness, you pay model calls to grade `===`. The per-surface dispatch costs a little routing code up front and is correct at every surface.

**The breakpoint.** A single method (exact-match) is defensible *only* while the only thing being evaluated is classification — intent and severity. The instant you eval diagnosis or recommendation prose, you must climb to rubric/judge, because exact-match on prose produces false failures that train the team to ignore the score. Conversely, the instant a judge is added, severity-weighting and human calibration become mandatory or the number is decorative.

---

## Tech reference (industry pairing)

### exact-match / classification metrics

- **Codebase uses:** nothing for evals — `classifyIntent` (`lib/agents/intent.ts` L17–L31) and `Severity` (`lib/mcp/types.ts` L3) produce exact-match-scoreable enums, but no scorer exists.
- **Why it's here (absent):** classification surfaces exist; no harness scores them.
- **Leading today:** scikit-learn-style accuracy / precision / recall / F1 are the standard classification metrics (2026).
- **Why it leads:** deterministic, free, universally understood; the only correct method for label output.
- **Runner-up:** confusion-matrix reporting — same data, more diagnostic detail on *which* labels confuse.

### rubric grading

- **Codebase uses:** nothing — `Diagnosis` (`lib/mcp/types.ts` L64–L73) is rubric-shaped but ungraded.
- **Why it's here (absent):** structured prose output exists with no quality decomposition.
- **Leading today:** explicit weighted criteria checklists, partly code-checkable, are the standard for structured-prose eval (2026).
- **Why it leads:** forces you to define "good" as concrete sub-questions; more objective and debuggable than a holistic score.
- **Runner-up:** holistic single-score rubrics — faster to write, less diagnostic when they fail.

### LLM-as-judge / pairwise

- **Codebase uses:** nothing — no judge model is wired for evaluation.
- **Why it's here (absent):** subjective surfaces (recommendation quality) exist with no nuanced scorer.
- **Leading today:** LLM-as-judge (absolute, e.g. G-Eval) and pairwise preference (Chatbot-Arena-style) are the standard for free-form prose and A/B (2026).
- **Why it leads:** approximates human preference at a fraction of the cost; pairwise is robust to scale drift.
- **Runner-up:** reward models / fine-tuned scorers — more consistent, far more setup.

---

## Project exercises

### Build `evals/runner.ts` pointable at the live agents

- **Exercise ID:** B3.1 / B3.3 (adapted) — the eval harness, the primary buildable target.
- **What to build:** a CLI runner that loads cases from `evals/fixtures/` (from `01-eval-set-types.md`), constructs the real agent for each case (`DiagnosticAgent`, `RecommendationAgent`, `MonitoringAgent`, or `classifyIntent`) with a real or recorded MCP context, runs it against the live model, and dispatches the output to a scorer by the case's declared surface — exact-match for intent/severity, F1 for monitoring sets, rubric for diagnosis/recommendation structure. Print a per-surface aggregate.
- **Why it earns its place:** shows you can stand up an eval loop against real agents and pick the right scorer per surface — the core competency of "we measure quality."
- **Files to touch:** `evals/runner.ts`, `evals/scorers/exact.ts`, `evals/scorers/f1.ts`, `evals/scorers/rubric.ts`; imports `lib/agents/diagnostic.ts`, `lib/agents/recommendation.ts`, `lib/agents/monitoring.ts`, `lib/agents/intent.ts`, types from `lib/mcp/types.ts`.
- **Done when:** `node evals/runner.ts` runs the golden set, scores each surface with its matched method, and prints precision/recall for monitoring and a rubric score for diagnosis.
- **Estimated effort:** 1–2 days

### Add a pairwise prompt-edit A/B mode

- **Exercise ID:** B3.3 (adapted) — pairwise comparison for prompt iteration.
- **What to build:** a `--compare promptA promptB` mode that runs the golden set through two versions of `lib/agents/prompts/diagnostic.md`, judges each case pairwise (using the debiased judge from `03-llm-as-judge-bias.md`), and reports a win-rate so a prompt edit is a measured A/B, not a vibe.
- **Why it earns its place:** demonstrates the exact decision tooling for "did my prompt change help?" — the signal that you iterate on prompts with evidence.
- **Files to touch:** `evals/runner.ts` (compare mode), `evals/scorers/pairwise.ts`, reads two variants of `lib/agents/prompts/diagnostic.md`.
- **Done when:** running compare mode over the golden set prints a win-rate for v2 over v1 with order randomized per case.
- **Estimated effort:** 1–2 days

---

## Summary

Once you have an eval set, you score it with a method matched to the output's variability: exact-match for a label, fuzzy/F1 for a set, a rubric for structured prose, an LLM-judge for nuance, pairwise for comparisons, human for ground truth. The methods form a ladder from cheap-and-strict to expensive-and-nuanced, and you climb only as high as the output forces you to — the same discipline as picking `toBe` over `toMatch`. In blooming insights, `classifyIntent` and anomaly severity are exact-match, `MonitoringAgent.scan`'s array output is F1, and `DiagnosticAgent`/`RecommendationAgent` prose is rubric-then-judge. None of this exists yet; it lives in a new `evals/runner.ts` plus per-method scorers.

**Key points:**
- Method choice tracks output entropy: low entropy → exact-match, high entropy → rubric/judge.
- Exact-match on prose produces false failures; LLM-judge on labels wastes money and adds bias.
- F1 hides which errors you made — report precision and recall separately, weight by severity.
- Pairwise (relative) is more reliable than absolute scoring for A/B decisions.
- Human review authors the references and calibrates the cheaper methods; it is not the per-run scorer.

---

## Interview defense

### What an interviewer is really asking

"How would you score your eval set?" tests whether you know that one method does not fit all surfaces. The junior answer is "LLM-as-judge" (the shiny one). The senior answer matches method to surface and justifies *not* using the judge where a cheaper method is correct — exact-match for intent, F1 for the monitoring set — and names the bias and cost you take on when you do climb to the judge.

### Likely questions

**[mid] How would you score the monitoring agent's output?**

`MonitoringAgent.scan` (`lib/agents/monitoring.ts` L68–L103) returns an *array* of anomalies, not one label, so it is a set-overlap problem: precision (were the flagged ones real?) and recall (did it catch the ones that matter?), combined as F1. Exact-match is too strict — one extra item or a different order should not zero the score — and a rubric is overkill for structured items.

```
expected ∩ flagged → precision & recall → F1
```

**[senior] Why not just use LLM-as-judge for everything? It's the most capable.**

Because it is the most expensive and the only one with bias. Judging `classifyIntent`'s one-word enum output (`lib/agents/intent.ts` L17–L31) with a model call is paying for, and importing bias into, what `===` grades for free and correctly. Climb to the judge only when a rubric cannot capture the nuance — diagnosis/recommendation prose — and even then control for the biases in `03-llm-as-judge-bias.md`.

```
intent enum → exact-match (free, correct)   NOT judge (paid, biased)
rec prose   → judge (nuance the rubric misses)
```

**[arch] You edited `diagnostic.md` to improve diagnoses. How do you prove it helped?**

Pairwise A/B over the golden set: run each case through v1 and v2 of the prompt, judge "which is better" per case, report a win-rate. Pairwise beats absolute scoring here because you do not need a calibrated 1–5 scale — only a consistent relative judgment — and relative judgments are more reliable from both humans and models.

```
golden set → {v1 out, v2 out} → judge pairwise → win-rate(v2)
```

### The question candidates always dodge

**"What does an F1 of 0.7 actually tell you to do?"** On its own, almost nothing — it hides whether you are missing critical anomalies (dangerous) or flagging harmless noise (annoying). The honest answer is that you never report a bare F1: you report precision and recall separately, and for monitoring you weight recall on `critical` severity far above `info`, because the cost of missing a critical anomaly is not symmetric with flagging an extra info one. People who quote a single aggregate have not thought about the asymmetry of the errors.

### One-line anchors

- The ladder: exact-match → fuzzy/F1 → rubric → LLM-judge → pairwise → human.
- Climb only as high as output variability forces you — same as `toBe` vs. `toMatch`.
- intent/severity → exact-match; monitoring set → F1; diagnosis/rec prose → rubric/judge.
- F1 hides the error type — always split precision and recall, weight by severity.
- Pairwise (relative) beats absolute scoring for prompt/model A/B.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the six-rung ladder from cheapest/strictest to most expensive/nuanced, and write the one-line rule for when to climb a rung.

### Level 2 — Explain

Out loud: why is exact-match correct for `classifyIntent` output but wrong for a `Diagnosis` conclusion? Tie it to output entropy (the size of the correct-answer space).

### Level 3 — Apply

Scenario: you must eval `MonitoringAgent.scan`. Open `lib/agents/monitoring.ts` L68–L103 and note it returns an array sorted by severity and sliced to 10. Explain why F1 (not exact-match, not a rubric) fits, and why you would weight recall on `critical` (`lib/mcp/types.ts` L3) above `info`.

### Level 4 — Defend

A colleague proposes one LLM-as-judge scorer for every surface "so the harness is simple." Argue the per-surface cost: name a surface where the judge wastes money and adds bias (intent/severity) and a surface where it is genuinely needed (recommendation prose), and state the simplest correct method for each.

### Quick check — code reference test

What does `classifyIntent` (`lib/agents/intent.ts` L17–L31) return, and which scoring method fits it and why? (Answer: one of three enum words — it caps `max_tokens` at 16 to force a single-word answer — so exact-match (`===`) is the correct method: the output space is a single label with zero correct variation, so no tolerance is needed and a judge would only add cost and bias.)

---
Updated: 2026-05-28 — Test count 125→157; re-derived `MonitoringAgent.scan` (monitoring.ts L68–L103) and `Diagnosis` (types.ts L64–L73) refs. `classifyIntent` (intent.ts L17–L31), `propose` (recommendation.ts L36–L77), and Severity (types.ts L3) unchanged. Still Case B.
